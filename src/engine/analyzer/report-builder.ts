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

/** finding + 命中处源码片段（报告里直接看代码，不用回跳文件） */
export interface AnalysisFindingWithSnippet extends AnalyzerFinding {
  /** 命中行的源码（最多 3 行，已去缩进前缀） */
  snippet?: string
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
  /** 来源：缺省=静态规则生成；"ai"=模型复核生成的详细方案（报告里标 [AI]） */
  source?: "ai"
}

export interface AnalysisReport {
  schemaVersion: "1.0"
  analyzerVersion: string
  ruleSetVersion: string
  sourceHash: string
  generatedAt: string
  file?: string
  /**
   * 统计口径（P0 统一，2026-11-19）：
   *  - `findings` / `summary.counts` / `summary.totalFindings` / `ruleInventory` 是 **aggregate** 口径
   *    （入口 + 全部子 workflow），Markdown/JSON/Dashboard 全取这一份，避免同一分析出现两套数字。
   *  - `entry` 保留入口自身明细，供报告区分「入口 vs 子流程」。
   *  - `summary.riskScore` 仍是**入口自身**风险分；聚合风险用 `aggregateRiskScore`（取最危险单文件）。
   */
  summary: {
    riskScore: number
    counts: Record<Severity, number>
    totalFindings: number
  }
  /** 入口自身明细（跨文件分析时存在，与顶层 aggregate 区分） */
  entry?: {
    findings: AnalysisFindingWithSnippet[]
    ruleInventory: AnalysisReport["ruleInventory"]
    totalFindings: number
  }
  /** 聚合风险分：取最危险单文件（不求和，避免饱和到 100 丢失区分度） */
  aggregateRiskScore?: number
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
  /** 全量规则检查清单：每条规则检查了什么、命中几条（0 = 通过） */
  ruleInventory: Array<{
    id: string
    severity: string
    description: string
    hits: number
    /** ai-only = 该规则由 AI Rule Check 判定，静态层不产出结论 */
    status: "hit" | "pass" | "error" | "ai-only"
    error?: string
  }>
  findings: AnalysisFindingWithSnippet[]
  recommendations: Recommendation[]
  diagnostics: string[]
  /** AI Rule Check 结果（默认开启；未启用或为空时缺省） */
  aiRuleCheck?: {
    status: "completed" | "partial" | "failed" | "skipped"
    durationMs?: number
    checks: Array<{
      ruleId: string
      status: "hit" | "pass" | "uncertain" | "not-applicable" | "error"
      confidence: number
      reason: string
      error?: string
      evidence: Array<{ file: string; startLine: number; endLine: number; quote: string }>
    }>
    diagnostics: string[]
  }
  /** 静态 × AI 合并后的规则结论（报告与 Dashboard 的规则表来源） */
  ruleMerge?: Array<{
    ruleId: string
    severity: string
    description: string
    staticStatus: "hit" | "pass" | "error" | "ai-only"
    staticHits: number
    staticError?: string
    aiStatus?: string
    aiConfidence?: number
    aiEvidenceCount: number
    finalStatus: string
    note?: string
  }>
  /** 跨文件聚合（分析入口 + 子 workflow 时填充） */
  subtree?: {
    files: number
    callSites: number
    totalFindings: number
    maxRisk: number
    riskiest?: string
    rules: Record<string, number>
    subWorkflows: Array<{
      file: string
      riskScore: number
      callSites: number
      totalFindings: number
      topRule?: string
      /** 子流程 finding 明细：Dashboard 问题列表要能展示，否则看似"规则全通过" */
      findings: Array<{
        ruleId: string
        severity: string
        confidence: number
        startLine: number
        endLine: number
        evidence: string[]
        suggestion?: string
        snippet?: string
      }>
    }>
  }
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
  const { findings, context, ruleRuns } = runRules(input.source, {
    ...(input.file ? { file: input.file } : {}),
  })
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const f of findings) counts[f.severity]++
  const sourceLines = input.source.split("\n")
  const findingsWithSnippet: AnalysisFindingWithSnippet[] = findings.map((f) => {
    const from = Math.max(1, f.location.startLine)
    const to = Math.min(sourceLines.length, Math.max(from, f.location.endLine))
    const snippetLines = sourceLines.slice(from - 1, Math.min(to, from + 2))
    return {
      ...f,
      ...(snippetLines.length > 0 ? { snippet: snippetLines.join("\n").trimEnd() } : {}),
    }
  })

  return {
    schemaVersion: "1.0",
    ruleInventory: ruleRuns.map((r) => ({
      id: r.id,
      severity: r.severity,
      description: r.description,
      hits: r.hits,
      status: r.error
        ? ("error" as const)
        : r.hits > 0
          ? ("hit" as const)
          : r.aiOnly
            ? ("ai-only" as const)
            : ("pass" as const),
      ...(r.error ? { error: r.error } : {}),
    })),
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
    findings: findingsWithSnippet,
    recommendations: recommend(findings),
    diagnostics: context.ast.diagnostics,
  }
}

/** Markdown 渲染（人类可读摘要） */
export function renderMarkdown(report: AnalysisReport): string {
  const lines: string[] = []
  const e = report.executionEstimate
  lines.push(`# Workflow Analysis: ${report.file ?? "(inline)"}`)
  lines.push("")
  lines.push(`- analyzer ${report.analyzerVersion} / ruleSet ${report.ruleSetVersion}`)
  lines.push(`- sourceHash: \`${report.sourceHash.slice(0, 23)}…\``)
  lines.push(`- **入口风险分: ${report.summary.riskScore}/100**`)
  if (report.aggregateRiskScore !== undefined) {
    lines.push(`- **聚合风险分: ${report.aggregateRiskScore}/100**（取最危险单文件，不求和）`)
  }
  if (report.subtree && report.subtree.files > 1) {
    const entryCount = report.entry?.totalFindings ?? report.summary.totalFindings
    // subtree.totalFindings 是「入口 + 子流程」总数（aggregate 口径），子流程数需相减
    const subOnly = Math.max(0, report.subtree.totalFindings - entryCount)
    lines.push(
      `- 分析范围: ${report.subtree.files} 个文件 / ${report.subtree.callSites} 调用点` +
        (report.subtree.riskiest ? ` / 最危险 ${report.subtree.riskiest}` : ""),
    )
    lines.push(
      `- **问题口径: 入口 ${entryCount} 条 + 子 workflow ${subOnly} 条 = 聚合 ${report.summary.totalFindings} 条**`,
    )
  }
  lines.push("")
  lines.push("## 调用结构")
  lines.push("")
  lines.push(`- 调用点: ${e.callSites}（agent ${e.agentCallSites} / workflow ${e.workflowCallSites}）`)
  lines.push(`- 估算任务量: ${e.estimatedTasks}${e.determined ? "" : "（含动态节点，为下限估算）"}`)
  if (e.concurrency !== undefined) lines.push(`- 并发上限: ${e.concurrency}`)
  if (e.estimatedWaves !== undefined) lines.push(`- 预计波次: ${e.estimatedWaves}`)
  if (e.dynamicNodes > 0) lines.push(`- 动态节点: ${e.dynamicNodes}（静态不可精确判定）`)

  // ---- 检查清单（关键：让用户看到"检查了什么"，未命中也列出） ----
  lines.push("")
  lines.push("## 检查清单（全部规则都执行过）")
  lines.push("")
  // 有 AI 复核时多一列：静态结论不等于全部结论，尤其 ai-only 规则
  const hasAi = Boolean(report.aiRuleCheck)
  if (hasAi) {
    lines.push("| 规则 | 严重度 | 静态 | AI 复核 | 最终 | 检查项 |")
    lines.push("| --- | --- | --- | --- | --- | --- |")
  } else {
    lines.push("| 规则 | 严重度 | 结果 | 检查项 |")
    lines.push("| --- | --- | --- | --- |")
  }
  for (const r of report.ruleInventory) {
    const status =
      r.status === "error"
        ? "**执行失败**"
        : r.hits > 0
          ? `命中 ${r.hits}`
          : r.status === "ai-only"
            ? "静态不判定（由 AI 检查）"
            : "通过"
    if (!hasAi) {
      lines.push(`| \`${r.id}\` | ${r.severity} | ${status} | ${r.description} |`)
      continue
    }
    const merged = report.ruleMerge?.find((m) => m.ruleId === r.id)
    const aiCell = merged?.aiStatus
      ? `${merged.aiStatus}${merged.aiConfidence !== undefined ? ` (${merged.aiConfidence.toFixed(2)})` : ""}`
      : "未启用"
    const finalCell = merged?.finalStatus ?? "-"
    lines.push(`| \`${r.id}\` | ${r.severity} | ${status} | ${aiCell} | ${finalCell} | ${r.description} |`)
  }

  // ---- AI Rule Check 详情（默认开启；有结果就展厅，用户要能看到 AI 到底判了什么）----
  if (report.aiRuleCheck) {
    const rc = report.aiRuleCheck
    const hitCount = rc.checks.filter((c) => c.status === "hit").length
    const uncCount = rc.checks.filter((c) => c.status === "uncertain").length
    const errCount = rc.checks.filter((c) => c.status === "error").length
    const passed = rc.checks.filter((c) => c.status === "pass" || c.status === "not-applicable").length
    lines.push("")
    lines.push(
      `## AI 规则检查（${rc.status}${rc.durationMs !== undefined ? ` / ${(rc.durationMs / 1000).toFixed(0)}s` : ""}）`,
    )
    lines.push("")
    lines.push(`- 命中 ${hitCount} / 待确认 ${uncCount} / 通过 ${passed} / 失败 ${errCount}（共 ${rc.checks.length} 条）`)
    if (rc.diagnostics.length > 0) {
      lines.push(`- 诊断：${rc.diagnostics.slice(0, 5).join("；")}`)
    }
    lines.push("")
    for (const c of rc.checks) {
      if (c.status === "pass" || c.status === "not-applicable") continue
      lines.push(`### ${c.status.toUpperCase()} \`${c.ruleId}\`（置信度 ${c.confidence.toFixed(2)}）`)
      lines.push("")
      if (c.error) lines.push(`- 错误：${c.error}`)
      if (c.reason) lines.push(`- 判定依据：${c.reason}`)
      if (c.evidence.length > 0) {
        lines.push("")
        lines.push("证据：")
        for (const ev of c.evidence) {
          lines.push(`- \`${ev.file}:L${ev.startLine}-${ev.endLine}\``)
          lines.push("  ```")
          for (const ql of ev.quote.split("\n").slice(0, 6)) lines.push(`  ${ql}`)
          lines.push("  ```")
        }
      }
      lines.push("")
    }
  }

  // ---- findings 详情（带代码片段） ----
  lines.push("")
  lines.push(`## 发现的问题（${report.findings.length}）`)
  lines.push("")
  if (report.findings.length === 0) {
    lines.push("全部规则检查通过，未发现静态风险。")
  }
  for (const f of report.findings) {
    // 跨文件分析时必须带文件名：37 条 finding 分布 12 个文件，只给行号无法定位该改哪个文件
    const loc = f.location.file
      ? `${f.location.file}:L${f.location.startLine}-${f.location.endLine}`
      : `L${f.location.startLine}-${f.location.endLine}`
    lines.push(`### ${f.severity.toUpperCase()} \`${f.ruleId}\` @ ${loc}`)
    lines.push("")
    lines.push(`- 置信度: ${f.confidence.toFixed(2)}${f.confidence < 0.5 ? "（提示性，不计入风险分）" : ""}`)
    // evidence 单条截断：DET-001 会把整段 prompt 拼进一行，不截断会撑爆可读性
    for (const ev of f.evidence) {
      lines.push(`- ${ev.length > 300 ? `${ev.slice(0, 300)}…（完整内容见 JSON）` : ev}`)
    }
    if (f.snippet) {
      lines.push("")
      lines.push("```js")
      lines.push(f.snippet)
      lines.push("```")
    }
    if (f.suggestion) {
      lines.push("")
      lines.push(`**建议**：${f.suggestion}`)
    }
    lines.push("")
  }

  // ---- 子 workflow 明细 ----
  if (report.subtree && report.subtree.files > 1) {
    lines.push("## 子 Workflow 明细")
    lines.push("")
    lines.push(`- 聚合口径：取最危险单文件（不相加，避免虚高）`)
    lines.push(`- 规则分布：${Object.entries(report.subtree.rules).map(([k, v]) => `${k}×${v}`).join(", ")}`)
    lines.push("")
    lines.push("| 文件 | 风险分 | 调用点 | finding | 主要规则 |")
    lines.push("| --- | --- | --- | --- | --- |")
    for (const sw of report.subtree.subWorkflows) {
      lines.push(`| ${sw.file} | ${sw.riskScore} | ${sw.callSites} | ${sw.totalFindings} | ${sw.topRule ?? "-"} |`)
    }
    lines.push("")
  }

  // ---- 优化建议 ----
  lines.push("## 优化建议")
  lines.push("")
  if (report.recommendations.length === 0) lines.push("无。")
  for (const r of report.recommendations) {
    lines.push(`### ${r.id} ${r.title}${r.source === "ai" ? " `[AI]`" : ""}`)
    lines.push(`- 严重度: ${r.severity} / 质量风险: ${r.qualityRisk}`)
    lines.push(`- 预期收益: ${r.expectedImpact}`)
    lines.push(`- 验证条件: ${r.validation.join("；")}`)
    lines.push("")
  }

  if (report.dependencies.unknowns.length > 0) {
    lines.push("## 静态不可判定（禁止自动采纳）")
    lines.push("")
    for (const u of report.dependencies.unknowns) lines.push(`- L${u.line} ${u.id}: ${u.reason}`)
    lines.push("")
  }
  if (report.diagnostics.length > 0) {
    lines.push("## 诊断")
    lines.push("")
    for (const d of report.diagnostics) lines.push(`- ${d}`)
    lines.push("")
  }
  return lines.join("\n")
}

export function ruleSetSize(): number {
  return BUILTIN_RULES.length
}
