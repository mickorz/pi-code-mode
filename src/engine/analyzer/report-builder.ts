/**
 * Analysis Report 构建（M1-T4）
 *
 * 输出结构固定（含 sourceHash / analyzerVersion / ruleSetVersion / findings /
 * executionEstimate / recommendations），同脚本 + 同版本 → 确定性结果。
 */
import { createHash } from "node:crypto"

import { riskScore, runRules } from "./rule-engine.js"
import { BUILTIN_RULES } from "./rules/index.js"
import type { AnalyzerFinding, Severity } from "./types.js"

export const ANALYZER_VERSION = "1.0.0"
export const RULE_SET_VERSION = "1.0.0"

export interface ExecutionEstimate {
  /** 静态可确定的调用点数（agent + workflow） */
  callSites: number
  agentCallSites: number
  workflowCallSites: number
  /** 估算任务量（静态可确定部分；含动态节点时 determined=false） */
  estimatedTasks: number
  determined: boolean
  /** 静态可确定的并发上限（setConcurrency 字面量） */
  concurrency?: number
  /** 估算波次（estimatedTasks / concurrency） */
  estimatedWaves?: number
  /** 动态节点数（Unknown 来源） */
  dynamicNodes: number
}

export interface Recommendation {
  id: string
  title: string
  ruleIds: string[]
  severity: Severity
  /** 预期收益：无基准时必须是"待 Benchmark"（陷阱：不虚构数值） */
  expectedImpact: string
  qualityRisk: "low" | "medium" | "high"
  validation: string[]
}

export interface AnalysisReport {
  schemaVersion: "1.0"
  analyzerVersion: string
  ruleSetVersion: string
  sourceHash: string
  generatedAt: string
  file?: string
  summary: {
    riskScore: number
    counts: Record<Severity, number>
    totalFindings: number
  }
  executionEstimate: ExecutionEstimate
  callGraph: {
    nodes: Array<{ id: string; kind: string; line: number; label: string; dynamic: boolean }>
    edges: Array<{ from: string; to: string; confidence: string }>
    counts: Record<string, number>
  }
  dependencies: {
    serialChains: string[][]
    candidates: Array<{ ids: string[]; risk?: string }>
    unknowns: Array<{ id: string; line: number; reason: string }>
  }
  findings: AnalyzerFinding[]
  recommendations: Recommendation[]
  diagnostics: string[]
}

function estimateOf(context: ReturnType<typeof runRules>["context"]): ExecutionEstimate {
  const agentCallSites = context.graph.counts.agent ?? 0
  const workflowCallSites = context.graph.counts.workflow ?? 0
  const dynamicNodes = context.ast.nodes.filter((n) => n.dynamic).length
  let estimatedTasks = 0
  let determined = true
  for (const n of context.ast.nodes) {
    if (n.kind !== "agent" && n.kind !== "workflow") continue
    const max = n.loopBounds?.max
    if (n.dynamic) {
      determined = false
      if (max !== undefined) estimatedTasks += max
      else estimatedTasks += 1 // 下限占位（不伪造精确值）
    } else estimatedTasks += 1
  }
  const m = /setConcurrency\s*\(\s*(\d+)\s*\)/.exec(context.source)
  const concurrency = m ? Number(m[1]) : context.concurrency
  return {
    callSites: agentCallSites + workflowCallSites,
    agentCallSites,
    workflowCallSites,
    estimatedTasks,
    determined,
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(concurrency !== undefined && estimatedTasks > 0 ? { estimatedWaves: Math.ceil(estimatedTasks / concurrency) } : {}),
    dynamicNodes,
  }
}

/** findings → 结构化建议（每条 suggestion 一个 recommendation，收益不虚构） */
function recommend(findings: AnalyzerFinding[]): Recommendation[] {
  const groups = new Map<string, AnalyzerFinding[]>()
  for (const f of findings) {
    if (!f.suggestion) continue
    const key = f.ruleId
    groups.set(key, [...(groups.get(key) ?? []), f])
  }
  const out: Recommendation[] = []
  let seq = 0
  for (const [ruleId, list] of groups) {
    const severity = list.reduce<Severity>(
      (acc, f) => (riskWeight[f.severity] > riskWeight[acc] ? f.severity : acc),
      "low",
    )
    out.push({
      id: `OPT-${String(++seq).padStart(3, "0")}`,
      title: list[0]!.suggestion!.split(/[；;。]/)[0]!.slice(0, 60),
      ruleIds: [ruleId],
      severity,
      // 静态分析不产生数值收益（M1 原则三：优化必须有真实数据依据）
      expectedImpact: "待 Benchmark 验证（静态估算不提供数值收益）",
      qualityRisk: ruleId === "INPUT-001" ? "high" : "low",
      validation:
        ruleId === "INPUT-001"
          ? ["确认所有原始证据仍可按需读取（Evidence Reference 层保留）", "对比优化前后需求覆盖率不下降"]
          : ["重新运行 Analyzer 确认风险消除", "Benchmark 对比耗时与 Token 不劣化"],
    })
  }
  return out
}

const riskWeight: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 }

export function buildReport(input: {
  source: string
  file?: string
  /** 固定输出时间（测试确定性用；缺省当前时间） */
  generatedAt?: string
}): AnalysisReport {
  const { findings, context } = runRules(input.source, {
    ...(input.file ? { file: input.file } : {}),
  })
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const f of findings) counts[f.severity]++
  return {
    schemaVersion: "1.0",
    analyzerVersion: ANALYZER_VERSION,
    ruleSetVersion: RULE_SET_VERSION,
    sourceHash: `sha256:${createHash("sha256").update(input.source).digest("hex")}`,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    ...(input.file ? { file: input.file } : {}),
    summary: { riskScore: riskScore(findings), counts, totalFindings: findings.length },
    executionEstimate: estimateOf(context),
    callGraph: {
      nodes: context.graph.nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        line: n.line,
        label: n.label,
        dynamic: n.dynamic,
      })),
      edges: context.graph.edges.map((e) => ({ from: e.from, to: e.to, confidence: e.confidence })),
      counts: context.graph.counts,
    },
    dependencies: {
      serialChains: context.deps.serialChains,
      candidates: context.deps.candidates.map((c) => ({ ids: c.ids, ...(c.risk ? { risk: c.risk } : {}) })),
      unknowns: context.deps.unknowns.map((u) => ({ id: u.id, line: u.line, reason: u.reason })),
    },
    findings,
    recommendations: recommend(findings),
    diagnostics: context.ast.diagnostics,
  }
}

/** Markdown 渲染（人类可读摘要） */
export function renderMarkdown(report: AnalysisReport): string {
  const lines: string[] = []
  lines.push(`# Workflow Analysis: ${report.file ?? "(inline)"}`)
  lines.push("")
  lines.push(`- analyzer ${report.analyzerVersion} / ruleSet ${report.ruleSetVersion}`)
  lines.push(`- sourceHash: \`${report.sourceHash.slice(0, 23)}…\``)
  lines.push(`- **Risk Score: ${report.summary.riskScore}/100**`)
  lines.push("")
  lines.push("## 调用结构")
  lines.push("")
  const e = report.executionEstimate
  lines.push(`- 调用点: ${e.callSites}（agent ${e.agentCallSites} / workflow ${e.workflowCallSites}）`)
  lines.push(`- 估算任务量: ${e.estimatedTasks}${e.determined ? "" : "（含动态节点，为下限估算）"}`)
  if (e.concurrency !== undefined) lines.push(`- 并发上限: ${e.concurrency}`)
  if (e.estimatedWaves !== undefined) lines.push(`- 预计波次: ${e.estimatedWaves}`)
  if (e.dynamicNodes > 0) lines.push(`- 动态节点: ${e.dynamicNodes}（静态不可精确判定）`)
  lines.push("")
  lines.push("## 发现的问题")
  lines.push("")
  if (report.findings.length === 0) lines.push("无。")
  for (const f of report.findings) {
    lines.push(
      `- **${f.severity.toUpperCase()}** \`${f.ruleId}\` (L${f.location.startLine}-${f.location.endLine}, conf ${f.confidence.toFixed(2)})`,
    )
    for (const ev of f.evidence) lines.push(`  - ${ev}`)
    if (f.suggestion) lines.push(`  - 建议：${f.suggestion}`)
  }
  lines.push("")
  lines.push("## 优化建议")
  lines.push("")
  if (report.recommendations.length === 0) lines.push("无。")
  for (const r of report.recommendations) {
    lines.push(`### ${r.id} ${r.title}`)
    lines.push(`- 严重度: ${r.severity} / 质量风险: ${r.qualityRisk}`)
    lines.push(`- 预期收益: ${r.expectedImpact}`)
    lines.push(`- 验证条件: ${r.validation.join("；")}`)
  }
  if (report.dependencies.unknowns.length > 0) {
    lines.push("")
    lines.push("## 静态不可判定（禁止自动采纳）")
    lines.push("")
    for (const u of report.dependencies.unknowns) lines.push(`- L${u.line} ${u.id}: ${u.reason}`)
  }
  if (report.diagnostics.length > 0) {
    lines.push("")
    lines.push("## 诊断")
    for (const d of report.diagnostics) lines.push(`- ${d}`)
  }
  return lines.join("\n")
}

export function ruleSetSize(): number {
  return BUILTIN_RULES.length
}
