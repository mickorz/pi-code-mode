/**
 * Evaluator（M5-T1）：Plan estimated vs 实际执行对比
 *
 * 输入：Plan（stages 的 estimatedAgents/estimatedInputTokens）+ 运行记录（M2 指标 / journal / M3 checkpoint）
 * 输出：偏差率、超预算项、per-stage 对比
 *
 * 原则（架构基线）：预估与实测分离，偏差按**同类输入规模**比较；
 * 禁止为了让指标好看去倒推估算值。
 */
import type { WorkflowPlan, PlanStage } from "../plan/schema.js"

export interface ActualStageMetrics {
  stageId: string
  agents: number
  inputTokens?: number
  outputTokens?: number
  durationMs?: number
  failed?: number
}

export interface StageComparison {
  stageId: string
  name?: string
  estimated: { agents: number; inputTokens?: number }
  actual: { agents: number; inputTokens?: number; durationMs?: number }
  /** 偏差率 = (actual - estimated) / estimated（estimated=0 时为 undefined） */
  agentDeviation?: number
  tokenDeviation?: number
  over: boolean
}

export interface EvaluationReport {
  workflowId?: string
  runId: string
  planHash?: string
  /** 输入规模标记（偏差只在同类规模下可比） */
  inputScale?: string
  stages: StageComparison[]
  summary: {
    estimatedAgents: number
    actualAgents: number
    agentDeviation?: number
    estimatedInputTokens: number
    actualInputTokens: number
    tokenDeviation?: number
    durationMs: number
    failedAgents: number
    /** 超预算项（M2 budget 相关） */
    overBudget: string[]
  }
  /** 无预估数据的 stage（不可计算偏差，需 Analyzer 补齐） */
  missingEstimate: string[]
}

function deviation(actual: number, estimated: number): number | undefined {
  if (!Number.isFinite(estimated) || estimated <= 0) return undefined
  return (actual - estimated) / estimated
}

/** 从 Plan 的 stages 提取预估值；实际值按 stageId 匹配 */
export function evaluate(input: {
  plan?: WorkflowPlan
  runId: string
  actuals: ActualStageMetrics[]
  inputScale?: string
  budget?: { maxAgents?: number; maxInputTokens?: number }
}): EvaluationReport {
  const stages: StageComparison[] = []
  const missingEstimate: string[] = []
  const plannedById = new Map<string, PlanStage>()
  for (const s of input.plan?.definition?.stages ?? []) plannedById.set(s.id, s)

  const actualById = new Map(input.actuals.map((a) => [a.stageId, a]))
  const ids = [...new Set([...plannedById.keys(), ...actualById.keys()])].sort()

  let estAgents = 0
  let actAgents = 0
  let estTokens = 0
  let actTokens = 0
  let duration = 0
  let failed = 0
  const overBudget: string[] = []

  for (const id of ids) {
    const planned = plannedById.get(id)
    const actual = actualById.get(id)
    const estimatedAgents = planned?.estimatedAgents ?? 0
    const estimatedInputTokens = planned?.estimatedInputTokens
    const actualAgents = actual?.agents ?? 0
    const actualInputTokens = actual?.inputTokens

    if (!planned && actual) missingEstimate.push(id)

    const agentDev = deviation(actualAgents, estimatedAgents)
    const tokenDev =
      estimatedInputTokens !== undefined && actualInputTokens !== undefined
        ? deviation(actualInputTokens, estimatedInputTokens)
        : undefined

    const over =
      (agentDev !== undefined && agentDev > 0.2) || (tokenDev !== undefined && tokenDev > 0.2)

    stages.push({
      stageId: id,
      ...(planned?.name ? { name: planned.name } : {}),
      estimated: { agents: estimatedAgents, ...(estimatedInputTokens !== undefined ? { inputTokens: estimatedInputTokens } : {}) },
      actual: { agents: actualAgents, ...(actualInputTokens !== undefined ? { inputTokens: actualInputTokens } : {}), ...(actual?.durationMs !== undefined ? { durationMs: actual.durationMs } : {}) },
      ...(agentDev !== undefined ? { agentDeviation: agentDev } : {}),
      ...(tokenDev !== undefined ? { tokenDeviation: tokenDev } : {}),
      over,
    })

    estAgents += estimatedAgents
    actAgents += actualAgents
    estTokens += estimatedInputTokens ?? 0
    actTokens += actualInputTokens ?? 0
    duration += actual?.durationMs ?? 0
    failed += actual?.failed ?? 0
  }

  if (input.budget?.maxAgents !== undefined && actAgents > input.budget.maxAgents) {
    overBudget.push(`agents ${actAgents} > ${input.budget.maxAgents}`)
  }
  if (input.budget?.maxInputTokens !== undefined && actTokens > input.budget.maxInputTokens) {
    overBudget.push(`inputTokens ${actTokens} > ${input.budget.maxInputTokens}`)
  }

  return {
    ...(input.plan?.workflowId ? { workflowId: input.plan.workflowId } : {}),
    runId: input.runId,
    ...(input.plan?.planHash ? { planHash: input.plan.planHash } : {}),
    ...(input.inputScale ? { inputScale: input.inputScale } : {}),
    stages,
    summary: {
      estimatedAgents: estAgents,
      actualAgents: actAgents,
      ...(deviation(actAgents, estAgents) !== undefined ? { agentDeviation: deviation(actAgents, estAgents) } : {}),
      estimatedInputTokens: estTokens,
      actualInputTokens: actTokens,
      ...(deviation(actTokens, estTokens) !== undefined ? { tokenDeviation: deviation(actTokens, estTokens) } : {}),
      durationMs: duration,
      failedAgents: failed,
      overBudget,
    },
    missingEstimate,
  }
}

/** 渲染 MARKDOWN 报告 */
export function renderEvaluation(r: EvaluationReport): string {
  const pct = (v?: number) => (v === undefined ? "—" : `${(v * 100).toFixed(1)}%`)
  const lines: string[] = []
  lines.push(`# 执行评估：${r.workflowId ?? "(unknown)"} (run ${r.runId})`)
  lines.push("")
  if (r.inputScale) lines.push(`- 输入规模标记：${r.inputScale}（偏差仅在同规模下可比）`)
  lines.push(`- Agent：预估 ${r.summary.estimatedAgents} / 实际 ${r.summary.actualAgents}（偏差 ${pct(r.summary.agentDeviation)}）`)
  lines.push(`- Input Token：预估 ${r.summary.estimatedInputTokens} / 实际 ${r.summary.actualInputTokens}（偏差 ${pct(r.summary.tokenDeviation)}）`)
  lines.push(`- 耗时：${Math.round(r.summary.durationMs / 1000)}s / 失败 Agent：${r.summary.failedAgents}`)
  if (r.summary.overBudget.length) lines.push(`- **超预算**：${r.summary.overBudget.join("; ")}`)
  if (r.missingEstimate.length) lines.push(`- 缺预估（需 Analyzer 补齐）：${r.missingEstimate.join(", ")}`)
  lines.push("")
  lines.push("| Stage | 预估 Agents | 实际 Agents | 偏差 | 超阈 |")
  lines.push("| --- | --- | --- | --- | --- |")
  for (const s of r.stages) {
    lines.push(`| ${s.stageId} | ${s.estimated.agents} | ${s.actual.agents} | ${pct(s.agentDeviation)} | ${s.over ? "⚠" : ""} |`)
  }
  return lines.join("\n")
}
