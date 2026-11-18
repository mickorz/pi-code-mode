/**
 * Workflow Plan Schema（M1-T1）
 *
 * 唯一事实源：架构基线 2.2 节（dev-docs/design/workflow-engineering-framework.md）
 *  - Plan Definition（definition）：stages / quality（强制项），长期维护、只有一份
 *  - Plan Profile（profiles）：fast / balanced / quality，只覆盖执行策略，不复制 stages
 *  - 默认 Profile = balanced；Profile 不可覆盖 requiredValidation / acceptanceCriteria / stages 结构
 *  - planHash = SHA256(canonicalJSON(Plan without planHash))；analyzedAt 不参与
 */

/** 执行模式（继承 workflow-authoring 的速度/质量两档设计） */
export type ExecutionMode = "fast" | "balanced" | "quality"

/** Definition 级阶段声明（静态结构，来自 Analyzer 或手工维护） */
export interface PlanStage {
  id: string
  name?: string
  type: "parallel" | "sequential" | "dynamic"
  dependsOn?: string[]
  estimatedAgents?: number
  estimatedInputTokens?: number
}

/** Definition 级质量约束（Profile 不可关闭） */
export interface PlanQuality {
  /** 强制验证：Profile 只能增加验证，不能关闭 */
  requiredValidation: boolean
  acceptanceCriteria?: string[]
}

/** 执行策略（Profile 内可覆盖部分） */
export interface PlanExecutionPolicy {
  mode?: ExecutionMode
  /** Run 级并发上限（与 Agent 级并发是两个概念，此处为 Run 级） */
  concurrency?: { max?: number }
  modelPolicy?: { analysis?: string; writing?: string }
  budget?: {
    maxAgents?: number
    maxDurationMs?: number
    maxInputTokens?: number
    maxOutputTokens?: number
    maxRetries?: number
  }
}

/** 单个 Profile：只存差异化执行策略 */
export interface PlanProfile extends PlanExecutionPolicy {
  /** Profile 可追加（不可削减）的验证项 */
  additionalValidation?: string[]
}

/** Plan 文件结构 */
export interface WorkflowPlan {
  planVersion: string
  /** Plan 内容指纹；计算时剔除自身与 source.analyzedAt */
  planHash?: string
  workflowId?: string
  name?: string
  source: {
    scriptPath?: string
    scriptHash?: string
    /** 分析时间，报告元数据，不参与 planHash */
    analyzedAt?: string
  }
  definition: {
    stages: PlanStage[]
    quality: PlanQuality
  }
  profiles: Record<string, PlanProfile>
}

/** 本次 Run 的执行配置（与 WorkflowPlan 是两个概念；M2 Plan Runner 组合两者） */
export interface WorkflowRunConfig {
  workflowId?: string
  runId: string
  planHash?: string
  /** 本次选择（或初始选择）的 Profile 名 */
  activeProfile: ExecutionMode | string
  /** 当前 Profile 的独立指纹（追踪运行配置） */
  profileHash?: string
  /** 预算降级后当前实际生效策略（M2 P1-2） */
  effectivePolicy?: PlanExecutionPolicy
  /** 策略变更历史（M2 P1-2：每次变更 + 原因 + 时间） */
  policyTransitions?: Array<{ at: number; fromProfile: string; toProfile: string; reason: string }>
}

export const DEFAULT_PROFILE = "balanced"
export const SUPPORTED_PROFILES = ["fast", "balanced", "quality"] as const
