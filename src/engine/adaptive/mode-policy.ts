/**
 * Mode 策略执行器（M4-T5）
 *
 * Effective Validation = Required Validation ∪ Profile Validation
 *  - Required（Definition 级，恒生效）：requiredValidation 为 true 时，acceptanceCriteria 全部必须验证
 *  - Profile 只能**追加**验证，不能关闭 Required
 *
 * 同时产出各 mode 的执行差异（并发/验证数量/冗余评审），供 runtime 消费与审计。
 */
import type { ExecutionMode, PlanProfile, WorkflowPlan } from "../plan/schema.js"

export interface ValidationPlan {
  /** 必须执行的验证项（Required ∪ Profile） */
  required: string[]
  /** Profile 追加项 */
  additional: string[]
  /** Effective（= required ∪ additional，去重保序） */
  effective: string[]
  /** Required 是否启用（Definition 级，恒不可关闭） */
  requiredEnabled: boolean
}

export interface ModePolicy {
  mode: ExecutionMode | string
  concurrency?: number
  /** 冗余评审轮数（quality 加，fast 减） */
  reviewRounds: number
  /** 是否做交叉验证 */
  crossValidation: boolean
  validation: ValidationPlan
  /** 该 mode 的说明（审计用） */
  rationale: string
}

/**
 * 解析 mode → 具体策略。
 * @param plan Plan（提供 Definition.quality 强制项）
 * @param mode Profile 名（fast/balanced/quality）
 */
export function resolveModePolicy(plan: WorkflowPlan, mode: string): ModePolicy {
  const requiredEnabled = plan.definition?.quality?.requiredValidation === true
  const acceptance = plan.definition?.quality?.acceptanceCriteria ?? []
  const profile: PlanProfile = (plan.profiles?.[mode] ?? {}) as PlanProfile
  const additional = profile.additionalValidation ?? []

  // Effective = Required ∪ Additional（去重保序）
  const effective: string[] = []
  const seen = new Set<string>()
  for (const item of [...acceptance, ...additional]) {
    if (seen.has(item)) continue
    seen.add(item)
    effective.push(item)
  }

  const roundsByMode: Record<string, { rounds: number; cross: boolean; rationale: string }> = {
    fast: { rounds: 1, cross: false, rationale: "fast：减少非必要重复评审，提升并发" },
    balanced: { rounds: 1, cross: false, rationale: "balanced：常规验证与并发" },
    quality: { rounds: 2, cross: true, rationale: "quality：增加交叉验证与重复评审" },
  }
  const base = roundsByMode[mode] ?? { rounds: 1, cross: false, rationale: `${mode}：默认策略` }

  return {
    mode,
    ...(profile.concurrency?.max !== undefined ? { concurrency: profile.concurrency.max } : {}),
    reviewRounds: base.rounds,
    crossValidation: base.cross,
    validation: {
      required: [...acceptance],
      additional: [...additional],
      effective,
      requiredEnabled,
    },
    rationale: base.rationale,
  }
}

/**
 * 断言：Profile 未削弱 Required（供 runtime/测试作为不变量检查）。
 * 返回被违规移除的项（空 = 合规）。
 */
export function checkValidationNotWeakened(plan: WorkflowPlan, mode: string): string[] {
  const required = plan.definition?.quality?.acceptanceCriteria ?? []
  if (!required.length) return []
  const resolved = resolveModePolicy(plan, mode)
  return required.filter((r) => !resolved.validation.effective.includes(r))
}
