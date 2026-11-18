/**
 * Budget Tracker（M2-T1/T2/T2b）
 *
 * 三类预算（架构基线与执行计划 M2）：
 *  - 硬预算：maxAgents（总 dispatch 次数）/ maxDurationMs / maxRetries → dispatch 前拦截
 *  - 软预算：maxInputTokens / maxOutputTokens → 调用前原子预留 → usage 结算 → 可超限降级
 *  - 实际计量：模型返回 usage（无法精确时标记 estimated）
 *
 * Budget Reservation 五条约束（五轮评审 P1-1）：
 *  ① 预留必须原子执行
 *  ② 并发任务不能重复消费同一份预算余额
 *  ③ Agent 失败时释放未消费预留
 *  ④ Agent 完成时用实际 usage 结算差额
 *  ⑤ 无法获取真实 usage 时标记为估算，不伪装精确
 */
import type { PlanExecutionPolicy } from "../plan/schema.js"

export type ReservationStatus = "reserved" | "settled" | "released"

export interface BudgetReservation {
  reservationId: string
  runId: string
  agentCallId?: string
  estimatedTokens: number
  /** 分项预留（软预算并发安全的关键：input/output 分别占用） */
  reservedInput: number
  reservedOutput: number
  actualTokens?: number
  status: ReservationStatus
  estimated: boolean
}

export interface BudgetLimits {
  maxAgents?: number
  maxDurationMs?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxRetries?: number
}

export type BudgetKind = "hard-agents" | "hard-duration" | "hard-retries" | "soft-input" | "soft-output"

export interface BudgetViolation {
  kind: BudgetKind
  limit: number
  used: number
  /** 软预算超限时的建议动作 */
  action: "block" | "degrade" | "stop"
  message: string
}

export interface BudgetSnapshot {
  agents: { used: number; limit?: number }
  durationMs: { used: number; limit?: number }
  inputTokens: { used: number; limit?: number }
  outputTokens: { used: number; limit?: number }
  /** 已预留但未结算的 token（软预算并发安全的关键） */
  reservedInput: number
  reservedOutput: number
  /** 剩余可用（limit - used - reserved）；无上限时为 Infinity 语义（undefined） */
  remainingInput?: number
  remainingOutput?: number
}

/** 估算 token 数（无精确计量时的保守估算：约 4 字符/token） */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

let reservationSeq = 0

export class BudgetTracker {
  readonly runId: string
  readonly limits: BudgetLimits
  private agentsUsed = 0
  private retriesUsed = 0
  private inputUsed = 0
  private outputUsed = 0
  private startedAt: number
  private readonly reservations = new Map<string, BudgetReservation>()
  /** 是否出现估算（无真实 usage） */
  private usedEstimate = false

  constructor(input: { runId: string; limits?: BudgetLimits; startedAt?: number }) {
    this.runId = input.runId
    this.limits = input.limits ?? {}
    this.startedAt = input.startedAt ?? Date.now()
  }

  /** 硬预算：agent dispatch 前检查（maxAgents = 总 dispatch 次数） */
  canDispatch(now = Date.now()): BudgetViolation | null {
    const { maxAgents, maxDurationMs } = this.limits
    if (maxAgents !== undefined && this.agentsUsed >= maxAgents) {
      return {
        kind: "hard-agents",
        limit: maxAgents,
        used: this.agentsUsed,
        action: "block",
        message: `agent 数已达上限 ${maxAgents}（已 dispatch ${this.agentsUsed} 次）`,
      }
    }
    if (maxDurationMs !== undefined) {
      const elapsed = now - this.startedAt
      if (elapsed >= maxDurationMs) {
        return {
          kind: "hard-duration",
          limit: maxDurationMs,
          used: elapsed,
          action: "stop",
          message: `运行时间已达上限 ${Math.round(maxDurationMs / 1000)}s（已用 ${Math.round(elapsed / 1000)}s）`,
        }
      }
    }
    return null
  }

  /** 记录一次 dispatch（调用方在真正 dispatch 前调用） */
  recordDispatch(): void {
    this.agentsUsed++
  }

  /** 记录一次重试（硬预算 maxRetries 为 run 级累计上限） */
  recordRetry(): BudgetViolation | null {
    this.retriesUsed++
    const { maxRetries } = this.limits
    if (maxRetries !== undefined && this.retriesUsed > maxRetries) {
      return {
        kind: "hard-retries",
        limit: maxRetries,
        used: this.retriesUsed,
        action: "stop",
        message: `重试次数已达上限 ${maxRetries}`,
      }
    }
    return null
  }

  /**
   * 软预算原子预留（约束 ①②）：
   * 同步执行「检查剩余 ≥ 需求 → 登记预留」——JS 单线程内同步块即原子，
   * 并发 dispatch 不会重复消费同一份余额。
   * 返回 reservation 或 null（余额不足）。
   */
  reserve(input: { estimatedInputTokens: number; estimatedOutputTokens?: number; agentCallId?: string }): BudgetReservation | null {
    const needIn = Math.max(0, Math.round(input.estimatedInputTokens))
    const needOut = Math.max(0, Math.round(input.estimatedOutputTokens ?? 0))
    const snap = this.snapshot()
    if (snap.remainingInput !== undefined && needIn > snap.remainingInput) return null
    if (snap.remainingOutput !== undefined && needOut > snap.remainingOutput) return null

    const reservation: BudgetReservation = {
      reservationId: `res-${++reservationSeq}`,
      runId: this.runId,
      ...(input.agentCallId ? { agentCallId: input.agentCallId } : {}),
      estimatedTokens: needIn + needOut,
      reservedInput: needIn,
      reservedOutput: needOut,
      status: "reserved",
      estimated: true,
    }
    this.reservations.set(reservation.reservationId, reservation)
    return reservation
  }

  /** 软预算结算（约束 ④⑤）：用真实 usage 结算，差额归还；无 usage 时按估算计入并标记 */
  settle(
    reservationId: string,
    usage?: { input?: number; output?: number },
    outcome: "ok" | "failed" = "ok",
  ): { reservation: BudgetReservation | null; estimateOnly: boolean } {
    const r = this.reservations.get(reservationId)
    if (!r || r.status !== "reserved") return { reservation: null, estimateOnly: false }
    if (outcome === "failed" && !usage) {
      // 约束 ③：失败且无 usage → 释放预留，不计消耗
      r.status = "released"
      return { reservation: r, estimateOnly: false }
    }
    const actualIn = usage?.input
    const actualOut = usage?.output
    const estimateOnly = actualIn === undefined && actualOut === undefined
    // 无真实 usage：按预留值计入（估算，不伪装精确）
    this.inputUsed += actualIn ?? r.reservedInput
    this.outputUsed += actualOut ?? r.reservedOutput
    if (estimateOnly) this.usedEstimate = true
    r.actualTokens = (actualIn ?? 0) + (actualOut ?? 0)
    r.status = "settled"
    r.estimated = estimateOnly
    return { reservation: r, estimateOnly }
  }

  /** 约束 ③：显式释放（取消/失败未结算） */
  release(reservationId: string): boolean {
    const r = this.reservations.get(reservationId)
    if (!r || r.status !== "reserved") return false
    r.status = "released"
    return true
  }

  /** 直接记账（用于非预留路径，例如 runTool 等确定性节点） */
  recordUsage(usage: { input?: number; output?: number }, estimated = false): void {
    this.inputUsed += usage.input ?? 0
    this.outputUsed += usage.output ?? 0
    if (estimated) this.usedEstimate = true
  }

  /** 当前快照（含预留占用） */
  snapshot(now = Date.now()): BudgetSnapshot {
    let reservedInput = 0
    let reservedOutput = 0
    for (const r of this.reservations.values()) {
      if (r.status !== "reserved") continue
      reservedInput += r.reservedInput
      reservedOutput += r.reservedOutput
    }
    const { maxInputTokens, maxOutputTokens, maxAgents, maxDurationMs } = this.limits
    return {
      agents: { used: this.agentsUsed, ...(maxAgents !== undefined ? { limit: maxAgents } : {}) },
      durationMs: { used: now - this.startedAt, ...(maxDurationMs !== undefined ? { limit: maxDurationMs } : {}) },
      inputTokens: { used: this.inputUsed, ...(maxInputTokens !== undefined ? { limit: maxInputTokens } : {}) },
      outputTokens: { used: this.outputUsed, ...(maxOutputTokens !== undefined ? { limit: maxOutputTokens } : {}) },
      reservedInput,
      reservedOutput,
      ...(maxInputTokens !== undefined ? { remainingInput: Math.max(0, maxInputTokens - this.inputUsed - reservedInput) } : {}),
      ...(maxOutputTokens !== undefined ? { remainingOutput: Math.max(0, maxOutputTokens - this.outputUsed - reservedOutput) } : {}),
    }
  }

  /** 软预算超限检查（结算后调用）：返回建议动作 */
  checkSoftLimits(): BudgetViolation | null {
    const { maxInputTokens, maxOutputTokens } = this.limits
    if (maxInputTokens !== undefined && this.inputUsed > maxInputTokens) {
      return {
        kind: "soft-input",
        limit: maxInputTokens,
        used: this.inputUsed,
        action: "degrade",
        message: `input token 超软限 ${maxInputTokens}（已用 ${this.inputUsed}${this.usedEstimate ? "，含估算值" : ""}）`,
      }
    }
    if (maxOutputTokens !== undefined && this.outputUsed > maxOutputTokens) {
      return {
        kind: "soft-output",
        limit: maxOutputTokens,
        used: this.outputUsed,
        action: "degrade",
        message: `output token 超软限 ${maxOutputTokens}（已用 ${this.outputUsed}${this.usedEstimate ? "，含估算值" : ""}）`,
      }
    }
    return null
  }

  /** 供脚本 budget.remaining() 使用 */
  remaining(): { inputTokens?: number; outputTokens?: number; agents?: number; durationMs?: number; estimated: boolean } {
    const s = this.snapshot()
    return {
      ...(s.remainingInput !== undefined ? { inputTokens: s.remainingInput } : {}),
      ...(s.remainingOutput !== undefined ? { outputTokens: s.remainingOutput } : {}),
      ...(s.agents.limit !== undefined ? { agents: Math.max(0, s.agents.limit - s.agents.used) } : {}),
      ...(s.durationMs.limit !== undefined ? { durationMs: Math.max(0, s.durationMs.limit - s.durationMs.used) } : {}),
      estimated: this.usedEstimate,
    }
  }

  /** 汇总（写入 run 结果 / M5 Evaluator 输入） */
  totals(): { inputTokens: number; outputTokens: number; agents: number; retries: number; estimated: boolean; reservations: number } {
    return {
      inputTokens: this.inputUsed,
      outputTokens: this.outputUsed,
      agents: this.agentsUsed,
      retries: this.retriesUsed,
      estimated: this.usedEstimate,
      reservations: this.reservations.size,
    }
  }
}

/** 从 Plan Profile 提取 BudgetLimits */
export function limitsFromPolicy(policy: PlanExecutionPolicy | undefined): BudgetLimits {
  return policy?.budget ?? {}
}
