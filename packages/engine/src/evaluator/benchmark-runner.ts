/**
 * Benchmark 执行器（M6/4）
 *
 * 职责：把一个 workflow 脚本跑 before/after 两轮，产出可比较的真实指标 + 质量结论。
 *
 * 关键设计（架构基线陷阱 3/5）：
 *  - **不虚构数值**：所有指标来自真实执行（wall-clock / 记录里的 token / 失败数）
 *  - **质量不降级判定必须可用**：从 Plan 的 Definition.quality 提取必须验证项（Required Validation），
 *    执行结果需覆盖这些项（由调用方给 verifier，避免凭空判断）
 *  - **副作用安全**：after 轮应在独立工作区目录执行（调用方传独立 cwd），本模块不发号施令
 */
import { planSchedule, type TaskProfile } from "../adaptive/adaptive-scheduler.js"
import { checkValidationNotWeakened, resolveModePolicy } from "../adaptive/mode-policy.js"
import { evaluate, type EvaluationReport } from "./evaluator.js"
import type { WorkflowPlan } from "../plan/schema.js"

export interface BenchmarkRunMetrics {
  /** 墙钟耗时（真实测量） */
  durationMs: number
  /** 聚合指标（来自 runtime 结果/记录，可能缺省） */
  agents?: number
  inputTokens?: number
  outputTokens?: number
  failedAgents?: number
  /** 验证项通过情况（由 verifier 提供；undefined = 未验证） */
  validation?: { passed: string[]; failed: string[] }
  /** 运行是否成功（脚本未抛错 + 关键验证通过） */
  ok: boolean
  error?: string
}

export interface BenchmarkComparison {
  metric: keyof Pick<BenchmarkRunMetrics, "durationMs" | "inputTokens" | "outputTokens" | "agents" | "failedAgents">
  before?: number
  after?: number
  /** 改善比例（正 = 变好）；越小越好的指标已统一方向 */
  improvement?: number
}

export interface BenchmarkResult {
  plan?: WorkflowPlan
  mode?: string
  /** Required Validation 项（Definition 级强制，Profile 不可关闭） */
  requiredValidation: string[]
  before: BenchmarkRunMetrics
  after?: BenchmarkRunMetrics
  comparisons: BenchmarkComparison[]
  /** 质量结论 */
  quality: {
    /** Required Validation 是否全部执行并通过（缺验证器时为 unknown） */
    requiredValidationSatisfied: "yes" | "no" | "unknown"
    /** Profile 是否削弱了 Required（结构检查，不需要执行） */
    validationWeakened: boolean
    /** 质量是否降级（after 相比 before） */
    degraded: boolean
    reasons: string[]
  }
  /** 是否满足优化验收（更快/更省 且 质量不降级） */
  accepted: boolean
  notes: string[]
}

export interface BenchmarkOptions {
  /** 跑一次脚本（由调用方提供：可注入 fake、或真实 runWorkflow） */
  runOnce: (label: "before" | "after") => Promise<BenchmarkRunMetrics>
  /** 可选 Plan（提供则提取 Required Validation 与 mode 结构检查） */
  plan?: WorkflowPlan
  mode?: string
  /** 可选：历史画像（用于调度建议，不影响测量） */
  profiles?: Map<string, TaskProfile>
}

/** 从 Plan 提取必须验证项（Definition.quality.acceptanceCriteria），并检查 Profile 是否削弱 */
export function requiredValidationOf(plan: WorkflowPlan | undefined, mode?: string): { required: string[]; weakened: boolean } {
  const required = plan?.definition?.quality?.acceptanceCriteria ?? []
  if (!plan || !mode) return { required, weakened: false }
  const weakened = checkValidationNotWeakened(plan, mode).length > 0
  return { required, weakened }
}

/** 判定 Required Validation 是否被满足：所有 required 项必须在 passed 里，且不在 failed 里 */
export function validationSatisfied(
  required: string[],
  validation: BenchmarkRunMetrics["validation"],
): { status: "yes" | "no" | "unknown"; missing: string[]; failed: string[] } {
  if (!validation) return { status: "unknown", missing: [], failed: [] }
  const failed = required.filter((r) => validation.failed.includes(r))
  const missing = required.filter((r) => !validation.passed.includes(r) && !validation.failed.includes(r))
  if (failed.length > 0 || missing.length > 0) return { status: "no", missing, failed }
  return { status: "yes", missing: [], failed: [] }
}

function improvementOf(metric: BenchmarkComparison["metric"], before?: number, after?: number): number | undefined {
  if (before === undefined || after === undefined || before <= 0) return undefined
  // 所有纳入比较的指标都是「越小越好」
  return (before - after) / before
}

/**
 * 执行 benchmark：先 before，再 after（after 通常在工作区修改后）。
 * 不自己写基线；调用方拿到 result 后决定是否 record。
 */
export async function runBenchmark(opts: BenchmarkOptions): Promise<BenchmarkResult> {
  const notes: string[] = []
  const { required, weakened } = requiredValidationOf(opts.plan, opts.mode)
  if (weakened) notes.push(`Profile ${opts.mode} 削弱了 Definition 强制验证项（结构检查）`)

  if (opts.plan && opts.mode) {
    const policy = resolveModePolicy(opts.plan, opts.mode)
    notes.push(`mode=${policy.mode} 并发=${policy.concurrency ?? "-"} Required=${policy.validation.required.length}`)
  }

  const before = await opts.runOnce("before")
  const after = await opts.runOnce("after")

  const metrics: BenchmarkComparison["metric"][] = ["durationMs", "inputTokens", "outputTokens", "agents", "failedAgents"]
  const comparisons: BenchmarkComparison[] = metrics
    .map((metric) => ({
      metric,
      before: before[metric] as number | undefined,
      after: after[metric] as number | undefined,
      improvement: improvementOf(metric, before[metric] as number | undefined, after[metric] as number | undefined),
    }))
    .filter((c) => c.before !== undefined || c.after !== undefined)

  // 质量判定
  const reasons: string[] = []
  const beforeVal = validationSatisfied(required, before.validation)
  const afterVal = validationSatisfied(required, after.validation)

  let requiredStatus: BenchmarkResult["quality"]["requiredValidationSatisfied"] = "unknown"
  if (afterVal.status === "no") {
    requiredStatus = "no"
    reasons.push(`Required Validation 未满足：failed=${afterVal.failed.join(",") || "-"} missing=${afterVal.missing.join(",") || "-"}`)
  } else if (afterVal.status === "yes") {
    requiredStatus = "yes"
  } else {
    reasons.push("未提供验证结果（validation 缺省），Required Validation 无法确认")
  }

  // after 失败即质量降级
  let degraded = false
  if (!after.ok) {
    degraded = true
    reasons.push(`after 执行失败：${after.error ?? "unknown"}`)
  }
  if (weakened) degraded = true
  // before 通过而 after 未通过的验证项 → 降级
  if (beforeVal.status === "yes" && afterVal.status === "no") {
    degraded = true
    reasons.push("原先通过的强制验证在 after 中不再通过")
  }
  // 失败数上升 → 降级
  if (before.failedAgents !== undefined && after.failedAgents !== undefined && after.failedAgents > before.failedAgents) {
    degraded = true
    reasons.push(`失败 Agent 增加：${before.failedAgents} → ${after.failedAgents}`)
  }

  // 收益：至少一项主要指标改善 ≥5%
  const gains = comparisons.filter((c) => c.improvement !== undefined && c.improvement >= 0.05)
  // Required 未提供 validation 时是 unknown，不能默认放行（质量门不能被缺失数据绕过）
  const accepted = !degraded && requiredStatus === "yes" && gains.length > 0 && after.ok
  if (gains.length === 0) notes.push("未测得 ≥5% 的指标改善（不满足优化验收）")

  if (opts.profiles && opts.profiles.size > 0) {
    const schedule = planSchedule([{ taskKey: "probe", taskType: "probe" }], opts.profiles)
    notes.push(`画像可用于调度：${schedule.notes.join("；")}`)
  }

  return {
    ...(opts.plan ? { plan: opts.plan } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    requiredValidation: required,
    before,
    after,
    comparisons,
    quality: {
      requiredValidationSatisfied: requiredStatus,
      validationWeakened: weakened,
      degraded,
      reasons,
    },
    accepted,
    notes,
  }
}

/** 把 benchmark 结果转成 EvaluationReport（供 BaselineStore 记录 after 轮） */
export function toEvaluation(result: BenchmarkResult, input: { runId: string; inputScale?: string }): EvaluationReport {
  return evaluate({
    ...(result.plan ? { plan: result.plan } : {}),
    runId: input.runId,
    ...(input.inputScale ? { inputScale: input.inputScale } : {}),
    actuals: [
      {
        stageId: "benchmark",
        agents: result.after?.agents ?? 0,
        ...(result.after?.inputTokens !== undefined ? { inputTokens: result.after.inputTokens } : {}),
        ...(result.after?.durationMs !== undefined ? { durationMs: result.after.durationMs } : {}),
        ...(result.after?.failedAgents !== undefined ? { failed: result.after.failedAgents } : {}),
      },
    ],
  })
}

/** 渲染 Markdown */
export function renderBenchmark(result: BenchmarkResult): string {
  const lines = ["# Benchmark 结果", ""]
  lines.push(`- 结论：${result.accepted ? "**通过**（有改善且质量未降级）" : "**未通过**"}`)
  if (result.mode) lines.push(`- Mode：${result.mode}`)
  lines.push(`- Required Validation：${result.requiredValidation.length} 项（满足=${result.quality.requiredValidationSatisfied}）`)
  lines.push("")
  lines.push("| 指标 | before | after | 改善 |")
  lines.push("| --- | --- | --- | --- |")
  const pct = (v?: number) => (v === undefined ? "—" : `${(v * 100).toFixed(1)}%`)
  for (const c of result.comparisons) {
    lines.push(`| ${c.metric} | ${c.before ?? "—"} | ${c.after ?? "—"} | ${pct(c.improvement)} |`)
  }
  if (result.quality.reasons.length) {
    lines.push("", "## 质量结论")
    for (const r of result.quality.reasons) lines.push(`- ${r}`)
  }
  if (result.notes.length) {
    lines.push("", "## 备注")
    for (const n of result.notes) lines.push(`- ${n}`)
  }
  return lines.join("\n")
}
