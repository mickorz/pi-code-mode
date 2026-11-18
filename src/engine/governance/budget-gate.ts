/**
 * Budget Gate（M2-T3）：把预算接入 runtime 的 dispatch 边界
 *
 * 设计：runtime 只调用 gate 的三个方法（可选注入，旧脚本零改动）：
 *  - beforeDispatch(prompt) → { allow, reservation?, violation?, degradeTo? }
 *  - afterDispatch(reservationId, usage, outcome) → 结算并检查软限
 *  - snapshot() / remaining()
 *
 * 降级语义（P1-2）：软限超限 → 按 DEGRADE_ORDER 降档，只影响后续未调度任务。
 */
import type { PlanExecutionPolicy } from "../plan/schema.js"
import { BudgetTracker, estimateTokens, type BudgetViolation, type BudgetLimits } from "./budget-tracker.js"
import { DEGRADE_ORDER, nextDegradeTarget, PolicyState } from "./policy-state.js"

export interface GateDecision {
  allow: boolean
  /** 被拒原因（allow=false 时） */
  violation?: BudgetViolation
  /** 预留 id（allow=true 时；用于结算） */
  reservationId?: string
  /** 本次 dispatch 生效的策略（可能因降级变化） */
  policy?: PlanExecutionPolicy
  /** 是否发生了降级 */
  degraded?: { from: string; to: string; reason: string }
}

export interface BudgetGateOptions {
  runId: string
  limits: BudgetLimits
  activeProfile: string
  initialPolicy: PlanExecutionPolicy
  requiredValidation: boolean
  /** 各 Profile 的策略（降级时取目标 Profile） */
  profiles?: Record<string, PlanExecutionPolicy>
  /** 估算输出 token 的保守系数（缺省按 prompt 长度的 1/4 估 input，output 取 input 的 0.5） */
  outputEstimateRatio?: number
}

export class BudgetGate {
  readonly tracker: BudgetTracker
  readonly policyState: PolicyState
  private readonly profiles: Record<string, PlanExecutionPolicy>
  private readonly outputEstimateRatio: number
  /** 降级是否已用过（避免反复降级） */
  private degradeCount = 0

  constructor(opts: BudgetGateOptions) {
    this.tracker = new BudgetTracker({ runId: opts.runId, limits: opts.limits })
    this.policyState = new PolicyState({
      runId: opts.runId,
      activeProfile: opts.activeProfile,
      initialPolicy: opts.initialPolicy,
      requiredValidation: opts.requiredValidation,
    })
    this.profiles = opts.profiles ?? {}
    this.outputEstimateRatio = opts.outputEstimateRatio ?? 0.5
  }

  /** dispatch 前：硬预算拦截 + 软预算原子预留 */
  beforeDispatch(prompt: string, agentCallId?: string): GateDecision {
    // 1) 硬预算
    const hard = this.tracker.canDispatch()
    if (hard) return { allow: false, violation: hard }

    // 2) 软预算预留（原子）
    const estIn = estimateTokens(prompt)
    const estOut = Math.max(1, Math.round(estIn * this.outputEstimateRatio))
    const reservation = this.tracker.reserve({
      estimatedInputTokens: estIn,
      estimatedOutputTokens: estOut,
      ...(agentCallId ? { agentCallId } : {}),
    })
    if (!reservation) {
      // 余额不足以预留 → 尝试降级后重试一次
      const degraded = this.tryDegrade("软预算余量不足，无法预留")
      if (degraded) {
        const retry = this.tracker.reserve({
          estimatedInputTokens: estIn,
          estimatedOutputTokens: estOut,
          ...(agentCallId ? { agentCallId } : {}),
        })
        if (retry) {
          this.tracker.recordDispatch()
          return { allow: true, reservationId: retry.reservationId, policy: this.policyState.policy, degraded }
        }
      }
      return {
        allow: false,
        violation: {
          kind: "soft-input",
          limit: this.tracker.limits.maxInputTokens ?? 0,
          used: this.tracker.snapshot().inputTokens.used,
          action: "stop",
          message: "软预算余量不足且已无可降级目标",
        },
        ...(degraded ? { degraded } : {}),
      }
    }
    this.tracker.recordDispatch()
    return { allow: true, reservationId: reservation.reservationId, policy: this.policyState.policy }
  }

  /** dispatch 后：结算 + 软限检查（超限则下一次 dispatch 触发降级） */
  afterDispatch(reservationId: string | undefined, usage: { input?: number; output?: number } | undefined, outcome: "ok" | "failed" | "cancelled"): void {
    if (reservationId) {
      this.tracker.settle(reservationId, usage, outcome === "ok" ? "ok" : "failed")
    } else if (usage) {
      this.tracker.recordUsage(usage, usage.input === undefined && usage.output === undefined)
    }
  }

  /** 软限超限时降级（在 dispatch 边界调用；已降级过则不再降） */
  maybeDegradeOnSoftLimit(): { from: string; to: string; reason: string } | undefined {
    const v = this.tracker.checkSoftLimits()
    if (!v) return undefined
    return this.tryDegrade(v.message)
  }

  remaining() {
    return this.tracker.remaining()
  }

  totals() {
    return this.tracker.totals()
  }

  private tryDegrade(reason: string): { from: string; to: string; reason: string } | undefined {
    if (this.degradeCount >= DEGRADE_ORDER.length - 1) return undefined
    const from = this.policyState.profile
    const to = nextDegradeTarget(from)
    if (!to) return undefined
    const nextPolicy: PlanExecutionPolicy = this.profiles[to] ?? {}
    const changed = this.policyState.degrade(to, reason, nextPolicy)
    if (!changed) return undefined
    this.degradeCount++
    // 降级同时放宽并发上限（若目标 Profile 指定）
    return { from, to, reason }
  }
}
