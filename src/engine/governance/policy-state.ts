/**
 * 策略状态（M2-T3，五轮评审 P1-2：动态降级的 Run 级语义）
 *
 * - activeProfile：本次 Run 初始选择的 Profile（不变，用于追溯）
 * - effectivePolicy：当前实际生效的执行策略（可因降级变化）
 * - policyTransitions：每次变更 + 原因 + 时间
 *
 * 强制验证（Required Validation）永远生效——降级只能改变并发/模型/预算，
 * 不能关闭 Definition 级 requiredValidation / acceptanceCriteria。
 */
import type { PlanExecutionPolicy, WorkflowRunConfig } from "../plan/schema.js"

export interface PolicyTransition {
  at: number
  fromProfile: string
  toProfile: string
  reason: string
}

export class PolicyState {
  readonly runId: string
  readonly activeProfile: string
  private currentProfile: string
  private current: PlanExecutionPolicy
  private readonly transitions: PolicyTransition[] = []
  private readonly requiredValidation: boolean

  constructor(input: {
    runId: string
    activeProfile: string
    initialPolicy: PlanExecutionPolicy
    /** Definition 级强制项：恒生效，不因降级改变 */
    requiredValidation: boolean
  }) {
    this.runId = input.runId
    this.activeProfile = input.activeProfile
    this.currentProfile = input.activeProfile
    this.current = input.initialPolicy
    this.requiredValidation = input.requiredValidation
  }

  /** 当前生效策略 */
  get policy(): PlanExecutionPolicy {
    return this.current
  }

  /** 当前 Profile（降级后可能不同于 activeProfile） */
  get profile(): string {
    return this.currentProfile
  }

  /** 强制验证状态（降级不可关闭） */
  get validationRequired(): boolean {
    return this.requiredValidation
  }

  get history(): PolicyTransition[] {
    return [...this.transitions]
  }

  /**
   * 降级到目标 Profile：只影响后续尚未调度的任务。
   * 已派发的 agent 调用不受影响（调用方保证：本方法只在 dispatch 边界调用）。
   */
  degrade(toProfile: string, reason: string, nextPolicy: PlanExecutionPolicy, now = Date.now()): boolean {
    if (toProfile === this.currentProfile) return false
    this.transitions.push({ at: now, fromProfile: this.currentProfile, toProfile, reason })
    this.currentProfile = toProfile
    // 合并：新 Profile 策略覆盖执行字段；强制验证保持 Definition 值
    this.current = { ...this.current, ...nextPolicy }
    return true
  }

  /** 生成 WorkflowRunConfig（供 journal / 报告 / M5 Evaluator） */
  toRunConfig(extra: { workflowId?: string; planHash?: string; profileHash?: string } = {}): WorkflowRunConfig {
    return {
      ...(extra.workflowId ? { workflowId: extra.workflowId } : {}),
      runId: this.runId,
      ...(extra.planHash ? { planHash: extra.planHash } : {}),
      activeProfile: this.activeProfile,
      ...(extra.profileHash ? { profileHash: extra.profileHash } : {}),
      effectivePolicy: this.current,
      policyTransitions: this.history,
    }
  }
}

/** 降级候选顺序：quality → balanced → fast（不可反向自动升级） */
export const DEGRADE_ORDER = ["quality", "balanced", "fast"] as const

export function nextDegradeTarget(currentProfile: string): string | undefined {
  const idx = DEGRADE_ORDER.indexOf(currentProfile as (typeof DEGRADE_ORDER)[number])
  if (idx === -1) return "fast"
  return DEGRADE_ORDER[idx + 1]
}
