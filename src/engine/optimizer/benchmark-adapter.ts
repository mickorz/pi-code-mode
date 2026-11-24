/**
 * 真实 Benchmark 适配器（O2）
 *
 * 把「跑一次 workflow」变成可比较的指标集合，并给出 accept/reject 结论。
 *
 * 三条硬原则（继承 benchmark-runner 的架构基线）：
 *  1. 不虚构数值：所有指标来自真实执行（wall-clock / agent 记录 / 退出码）
 *  2. 质量门不可绕过：没有 Required Validation 或用户 verifier 时，quality=unavailable，禁止 apply
 *  3. before/after 必须同 args + 同 inputScale，否则不可比
 */
import type { BenchmarkRunMetrics } from "../evaluator/benchmark-runner.js"

/** 单次真实执行的结果（由调用方注入的执行器返回） */
export interface RealRunOutcome {
  ok: boolean
  durationMs: number
  agents: number
  /** undefined = 无法从 run 记录拿到（不虚构 0） */
  inputTokens?: number
  outputTokens?: number
  failedAgents: number
  error?: string
  /** 产物关键文件 sha256（质量比较用；缺省表示不校验产物） */
  artifacts?: Record<string, string>
}

export type RunWorkflowFn = (input: { scriptPath: string; cwd: string; label: "before" | "after" }) => Promise<RealRunOutcome>

/** 质量门来源 */
export type QualityGate =
  | { kind: "plan"; requiredValidation: string[] }
  | { kind: "verifier"; command: string }
  | { kind: "none" }

export interface BenchmarkComparisonItem {
  metric: "durationMs" | "inputTokens" | "outputTokens" | "agents" | "failedAgents"
  before?: number
  after?: number
  /** 改善比例（正 = 变好；都是越小越好） */
  improvement?: number
}

export interface BenchmarkVerdict {
  accepted: boolean
  reasons: string[]
  comparisons: BenchmarkComparisonItem[]
  before: RealRunOutcome
  after: RealRunOutcome
  quality: {
    status: "pass" | "fail" | "unavailable"
    detail: string
    /** 产物 hash 是否一致（未提供产物时为 undefined） */
    artifactsIdentical?: boolean
  }
  /** 至少一项主指标改善 >= 5% */
  hasGain: boolean
}

function improvementOf(before?: number, after?: number): number | undefined {
  if (before === undefined || after === undefined || before <= 0) return undefined
  return (before - after) / before
}

export interface RunBenchmarkInput {
  scriptPath: string
  cwd: string
  run: RunWorkflowFn
  qualityGate: QualityGate
  /** verifier 执行器（qualityGate.kind==='verifier' 时必需） */
  runVerifier?: (command: string, cwd: string) => Promise<{ ok: boolean; output?: string }>
  /** 最小改善阈值（缺省 5%） */
  minImprovement?: number
}

/** 跑 before/after 并给出结论 */
export async function runRealBenchmark(input: RunBenchmarkInput): Promise<BenchmarkVerdict> {
  const minImprovement = input.minImprovement ?? 0.05
  const before = await input.run({ scriptPath: input.scriptPath, cwd: input.cwd, label: "before" })
  const after = await input.run({ scriptPath: input.scriptPath, cwd: input.cwd, label: "after" })

  const comparisons: BenchmarkComparisonItem[] = (
    ["durationMs", "inputTokens", "outputTokens", "agents", "failedAgents"] as const
  )
    .map((metric) => ({
      metric,
      before: before[metric],
      after: after[metric],
      improvement: improvementOf(before[metric], after[metric]),
    }))
    .filter((c) => c.before !== undefined || c.after !== undefined)

  const reasons: string[] = []
  let accepted = true

  // ---- 硬失败条件 ----
  if (!after.ok) {
    accepted = false
    reasons.push(`after 执行失败：${after.error ?? "unknown"}`)
  }
  // before 失败 → 基线不可比。此前只查 after，会让「before 崩了、after 跑通」看起来像改善。
  if (!before.ok) {
    accepted = false
    reasons.push(`before 执行失败，基线不可比：${before.error ?? "unknown"}`)
  }
  if (after.failedAgents > before.failedAgents) {
    accepted = false
    reasons.push(`失败 Agent 增加：${before.failedAgents} → ${after.failedAgents}`)
  }

  // ---- 质量门 ----
  let quality: BenchmarkVerdict["quality"]
  if (input.qualityGate.kind === "none") {
    quality = { status: "unavailable", detail: "没有 Plan Required Validation 或 verifier，质量门无法判定" }
    accepted = false
    reasons.push("质量门不可用：缺少 Required Validation 或 verifier，禁止 apply")
  } else if (input.qualityGate.kind === "verifier") {
    if (!input.runVerifier) {
      quality = { status: "unavailable", detail: "verifier 未接线" }
      accepted = false
      reasons.push("verifier 未接线，质量门不可用")
    } else {
      const r = await input.runVerifier(input.qualityGate.command, input.cwd)
      quality = {
        status: r.ok ? "pass" : "fail",
        detail: r.ok ? `verifier 通过：${input.qualityGate.command}` : `verifier 失败：${r.output?.slice(0, 200) ?? input.qualityGate.command}`,
      }
      if (!r.ok) {
        accepted = false
        reasons.push("verifier 未通过")
      }
    }
  } else {
    // Plan Required Validation：需要有实际验证证据才能判 pass。
    // 这里不做虚假判定——调用方若没有 verifier 覆盖这些项，就是 unavailable。
    quality = {
      status: "unavailable",
      detail: `Plan 声明 ${input.qualityGate.requiredValidation.length} 项 Required Validation，但未提供 verifier 去验证`,
    }
    accepted = false
    reasons.push("Required Validation 缺 verifier：无法证明质量未降级")
  }

  // ---- 产物一致性 ----
  let artifactsIdentical: boolean | undefined
  if (before.artifacts && after.artifacts) {
    const keys = new Set([...Object.keys(before.artifacts), ...Object.keys(after.artifacts)])
    artifactsIdentical = [...keys].every((k) => before.artifacts![k] === after.artifacts![k])
    if (!artifactsIdentical) {
      accepted = false
      reasons.push("产物 hash 与 before 不一致（行为可能改变）")
    }
  }
  if (artifactsIdentical !== undefined) quality = { ...quality, artifactsIdentical }

  // ---- 收益 ----
  const gains = comparisons.filter((c) => c.improvement !== undefined && c.improvement >= minImprovement)
  const hasGain = gains.length > 0
  if (!hasGain) {
    accepted = false
    reasons.push(`没有任何主指标改善 ≥ ${(minImprovement * 100).toFixed(0)}%`)
  }

  return { accepted, reasons, comparisons, before, after, quality, hasGain }
}

/** 把真实结果转成 benchmark-runner 的指标结构（供 BaselineStore 记录） */
export function toBenchmarkMetrics(o: RealRunOutcome): BenchmarkRunMetrics {
  return {
    durationMs: o.durationMs,
    agents: o.agents,
    inputTokens: o.inputTokens,
    outputTokens: o.outputTokens,
    failedAgents: o.failedAgents,
    ok: o.ok,
    ...(o.error ? { error: o.error } : {}),
  }
}

/** 渲染 benchmark 结论 */
export function renderBenchmarkVerdict(v: BenchmarkVerdict): string {
  const pct = (x?: number) => (x === undefined ? "—" : `${(x * 100).toFixed(1)}%`)
  const lines: string[] = []
  lines.push(`- 结论：${v.accepted ? "**通过**（有改善且质量未降级）" : "**未通过**"}`)
  lines.push(`- 质量门：${v.quality.status}（${v.quality.detail}）`)
  if (v.quality.artifactsIdentical !== undefined) {
    lines.push(`- 产物一致性：${v.quality.artifactsIdentical ? "一致" : "**不一致**"}`)
  }
  lines.push("")
  lines.push("| 指标 | before | after | 改善 |")
  lines.push("| --- | ---: | ---: | ---: |")
  for (const c of v.comparisons) lines.push(`| ${c.metric} | ${c.before ?? "—"} | ${c.after ?? "—"} | ${pct(c.improvement)} |`)
  if (v.reasons.length) {
    lines.push("")
    lines.push("未通过原因：")
    for (const r of v.reasons) lines.push(`- ${r}`)
  }
  return lines.join("\n")
}
