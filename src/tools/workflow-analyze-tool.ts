/**
 * workflow_analyze 工具工厂（M1-T6）+ CLI 共用 Analyzer Core
 *
 * 两种入口共享同一 Analyzer Core（report-builder / optimization-planner），不各自实现。
 * - Pi 工具：workflow_analyze({ scriptPath | source, includeSuggestions, format })
 * - CLI：`pi-code-mode analyze <script> [--json|--md] [--suggest]`
 */
import fs from "node:fs"
import path from "node:path"

import { Type } from "typebox"

import {
  buildReport,
  clusterFindings,
  renderMarkdown,
  type AnalysisFindingWithSnippet,
  type AnalysisReport,
} from "../engine/analyzer/report-builder.js"
import {
  buildPlannerPrompt,
  mergeRecommendations,
  parsePlannerResponse,
  type PlannerOutput,
} from "../engine/analyzer/optimization-planner.js"
import { loadPlan } from "../engine/plan/plan-loader.js"
import { loadModelTiers } from "../engine/agent/model-tiers.js"
import { analyzeWorkflowTree } from "../engine/analyzer/tree-analyzer.js"
import { loadRuleDocs } from "../engine/analyzer/ai-rule-checker/rule-doc-loader.js"
import { runAIRuleCheck } from "../engine/analyzer/ai-rule-checker/ai-rule-checker.js"
import { mergeRuleResults } from "../engine/analyzer/ai-rule-checker/result-merger.js"
import { toSourceFiles } from "../engine/analyzer/ai-rule-checker/prompt-builder.js"
import type { Severity } from "../engine/analyzer/types.js"
import { PiAgentAdapter } from "../adapter/pi-agent-adapter.js"
import { runOptimizationLoop, renderLoopResult } from "../engine/evaluator/optimization-loop.js"
import { runBenchmark, renderBenchmark, toEvaluation } from "../engine/evaluator/benchmark-runner.js"

export interface AnalyzeInput {
  /** 脚本路径（与 source 二选一） */
  scriptPath?: string
  /**
   * 目录模式：分析目录下**全部 .js**（每个都当平级 workflow，不是「入口 + 子流程」语义）。
   * 与 scriptPath 互斥，scriptPath 优先。
   */
  dirPath?: string
  /** 内联脚本源码 */
  source?: string
  cwd?: string
  /** 附带 AI 优化建议（需要模型调用，由调用方注入） */
  includeSuggestions?: boolean
  /** AI 调用器（可选；缺省只做静态分析） */
  plannerAgent?: (prompt: string) => Promise<string>
  /** 输出格式 */
  format?: "json" | "md"
  /** 固定时间（测试确定性） */
  generatedAt?: string
  /** 是否写入报告文件（缺省 false） */
  writeReport?: boolean
  /** 跨文件聚合：连同子 workflow 一起分析（缺省 true，仅 scriptPath 模式可用） */
  recursive?: boolean
  /**
   * AI Rule Check（默认开启，需注入 agent）：读 rule.md + 源码逐条独立判定。
   * 与 plannerAgent 的区别：plannerAgent 只基于静态结论给建议，ruleCheckAgent 才做规则检查。
   */
  ruleCheckAgent?: (prompt: string) => Promise<string>
  /** 显式关闭 AI Rule Check（缺省按 ruleCheckAgent 是否存在决定） */
  includeRuleCheck?: boolean
  /**
   * AI 参与哪些规则（缺省 "semantic"）。
   *  - "semantic"：只查静态判定不可靠的规则（结构事实类如 RETRY-001/TIMEOUT-001 静态已足够确定）
   *  - "all"：全部规则都让 AI 复核（实测 14 条 × 并发 3 需 790s，仅适合按需开启）
   *
   * 默认值来源：实测 14 条全跑 13 分钟且有超时；6 条语义规则约 3~5 分钟，是体验与覆盖的折中。
   */
  /**
   * AI 参与哪些规则。数组形式用于「只复核特定规则」——optimize 只关心选中问题簇对应的规则，
   * 全量 6 条语义规则在 big 档下单次要 5~10 分钟，没有必要。
   */
  aiRules?: "all" | "semantic" | string[]
}

export interface AnalyzeResult {
  ok: boolean
  error?: string
  report?: AnalysisReport
  /** 合并后的建议（静态 + AI） */
  recommendations?: AnalysisReport["recommendations"]
  planner?: PlannerOutput
  /** Plan 状态（存在时） */
  plan?: { path: string; stale: boolean; defaultProfile: string; notes: string[] }
  rendered?: string
  reportPath?: string
}

/**
 * 目录模式：分析目录下**全部 .js** 并聚合。
 *
 * 与 scriptPath 的 tree 聚合不同：目录模式下每个文件都是**平级** workflow，
 * 没有"入口 vs 子流程"之分（用户传目录时的语义就是这个目录下的所有脚本）。
 *
 * 聚合口径与 tree 分支一致：顶层 findings/ruleInventory/summary 为 aggregate，
 * aggregateRiskScore 取最危险单文件（不求和）。
 */
async function analyzeDirectory(input: AnalyzeInput): Promise<AnalyzeResult> {
  const cwd = input.cwd ?? process.cwd()
  const dirAbs = path.resolve(cwd, input.dirPath!)
  if (!fs.existsSync(dirAbs)) return { ok: false, error: `目录不存在：${input.dirPath}` }

  let names: string[]
  try {
    names = fs.readdirSync(dirAbs).filter((n) => /\.(m?js)$/.test(n)).sort()
  } catch (e) {
    return { ok: false, error: `目录不可读：${input.dirPath}（${String((e as Error)?.message ?? e)}）` }
  }
  if (names.length === 0) return { ok: false, error: `目录下没有 .js 文件：${input.dirPath}` }

  const sources: Array<{ file: string; content: string }> = []
  const perFile: Array<{ file: string; report: AnalysisReport }> = []
  for (const name of names) {
    const abs = path.join(dirAbs, name)
    let src: string
    try {
      src = fs.readFileSync(abs, "utf8")
    } catch {
      continue // 单文件读失败不影响其余（目录里可能有临时/锁文件）
    }
    sources.push({ file: name, content: src })
    perFile.push({ file: name, report: buildReport({ source: src, file: name, ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}) }) })
  }
  if (perFile.length === 0) return { ok: false, error: `目录下没有可读的 .js 文件：${input.dirPath}` }

  // 聚合：findings 全部合并（标 file），ruleInventory 合并命中，counts 重算，风险取最大
  const aggregated: AnalysisFindingWithSnippet[] = []
  const counts = { critical: 0, high: 0, medium: 0, low: 0 } as Record<Severity, number>
  const ruleHits: Record<string, number> = {}
  for (const { file: fname, report } of perFile) {
    for (const f of report.findings) {
      aggregated.push({ ...f, location: { ...f.location, file: fname } })
      counts[f.severity] += 1
    }
    for (const r of report.ruleInventory) if (r.hits > 0) ruleHits[r.id] = (ruleHits[r.id] ?? 0) + r.hits
  }

  const first = perFile[0]!.report
  const maxRisk = Math.max(...perFile.map((p) => p.report.summary.riskScore))
  const riskiest = perFile.reduce((a, b) => (b.report.summary.riskScore > a.report.summary.riskScore ? b : a)).file

  // 目录模式没有单一入口，executionEstimate 必须用聚合值——否则摘要会显示
  // 第一个文件的"调用点 2"，与下方"40 个调用点"矛盾（用户会以为是漏分析）
  const est = perFile.reduce(
    (acc, p) => {
      const e = p.report.executionEstimate
      return {
        callSites: acc.callSites + e.callSites,
        agentCallSites: acc.agentCallSites + e.agentCallSites,
        workflowCallSites: acc.workflowCallSites + e.workflowCallSites,
        estimatedTasks: acc.estimatedTasks + e.estimatedTasks,
        dynamicNodes: acc.dynamicNodes + e.dynamicNodes,
        determined: acc.determined && e.determined,
        concurrency: acc.concurrency ?? e.concurrency,
        estimatedWaves: acc.estimatedWaves ?? e.estimatedWaves,
      }
    },
    {
      callSites: 0,
      agentCallSites: 0,
      workflowCallSites: 0,
      estimatedTasks: 0,
      dynamicNodes: 0,
      determined: true,
      concurrency: undefined as number | undefined,
      estimatedWaves: undefined as number | undefined,
    },
  )

  let report: AnalysisReport = {
    ...first,
    file: `dir:${input.dirPath}`,
    executionEstimate: {
      callSites: est.callSites,
      agentCallSites: est.agentCallSites,
      workflowCallSites: est.workflowCallSites,
      estimatedTasks: est.estimatedTasks,
      determined: est.determined,
      dynamicNodes: est.dynamicNodes,
      ...(est.concurrency !== undefined ? { concurrency: est.concurrency } : {}),
      ...(est.estimatedWaves !== undefined ? { estimatedWaves: est.estimatedWaves } : {}),
    },
    summary: { riskScore: first.summary.riskScore, counts, totalFindings: aggregated.length },
    findings: aggregated,
    // 必须重算：从 first 继承来的 clusters 只含第一个文件，会把 37 条显示成 3 个簇
    clusters: clusterFindings(aggregated),
    aggregateRiskScore: maxRisk,
    // 目录模式没有"入口"概念：entry 记第一个文件，报告头部靠 subtree 展示全量
    entry: { findings: first.findings, ruleInventory: first.ruleInventory, totalFindings: first.findings.length },
    ruleInventory: first.ruleInventory.map((r) => {
      const extra = ruleHits[r.id] ?? 0
      return extra > 0 ? { ...r, hits: r.hits + extra, status: "hit" as const } : r
    }),
    subtree: {
      files: perFile.length,
      callSites: perFile.reduce((n, p) => n + p.report.executionEstimate.callSites, 0),
      totalFindings: perFile.reduce((n, p) => n + p.report.summary.totalFindings, 0),
      maxRisk,
      riskiest,
      rules: ruleHits,
      subWorkflows: perFile.map((p) => {
        const rules: Record<string, number> = {}
        for (const f of p.report.findings) rules[f.ruleId] = (rules[f.ruleId] ?? 0) + 1
        return {
          file: p.file,
          riskScore: p.report.summary.riskScore,
          callSites: p.report.executionEstimate.callSites,
          totalFindings: p.report.summary.totalFindings,
          ...(p.report.findings[0] ? { topRule: p.report.findings[0].ruleId } : {}),
          findings: p.report.findings.map((f) => ({
            ruleId: f.ruleId,
            severity: f.severity,
            confidence: f.confidence,
            startLine: f.location.startLine,
            endLine: f.location.endLine,
            evidence: f.evidence,
            ...(f.suggestion ? { suggestion: f.suggestion } : {}),
            ...(f.snippet ? { snippet: f.snippet } : {}),
          })),
        }
      }),
    },
  }

  return runAiStages(report, sources, input)
}

/**
 * AI Rule Check + Planner（scriptPath / 目录模式共用）。
 * 抽出来避免两处逻辑漂移——AI 阶段的行为必须完全一致。
 */
async function runAiStages(
  reportIn: AnalysisReport,
  sources: Array<{ file: string; content: string }>,
  input: AnalyzeInput,
): Promise<AnalyzeResult> {
  let report = reportIn
  const SEMANTIC_AI_RULES = new Set(["CONC-002", "SERIAL-002", "DET-001", "REC-002", "BUDGET-001", "SIDEFX-001"])

  const wantRuleCheck = input.includeRuleCheck !== false && Boolean(input.ruleCheckAgent)
  if (wantRuleCheck && input.ruleCheckAgent) {
    try {
      const loaded = loadRuleDocs()
      for (const p of loaded.problems) report.diagnostics.push(`规则文档：${p}`)
      const aiRules = Array.isArray(input.aiRules)
        ? loaded.rules.filter((r) => input.aiRules!.includes(r.id))
        : input.aiRules === "all"
          ? loaded.rules
          : loaded.rules.filter((r) => SEMANTIC_AI_RULES.has(r.id))
      if (aiRules.length > 0) {
        const staticSummary = [
          `风险分 ${report.summary.riskScore}/100，聚合 ${report.summary.totalFindings} 条 finding，${report.subtree?.files ?? 1} 个文件。`,
          "静态规则结果：" +
            report.ruleInventory
              .map((r) => `${r.id}=${r.status === "error" ? "error" : r.hits > 0 ? `hit(${r.hits})` : "pass"}`)
              .join(", "),
          ...report.findings.slice(0, 12).map(
            (f) => `- ${f.ruleId} ${f.severity} ${f.location.file ?? "(entry)"}:${f.location.startLine}-${f.location.endLine} ${f.evidence[0] ?? ""}`,
          ),
        ].join("\n")
        const aiResult = await runAIRuleCheck({
          rules: aiRules,
          sources: toSourceFiles(sources),
          staticSummary,
          plannerAgent: input.ruleCheckAgent,
        })
        report = {
          ...report,
          aiRuleCheck: {
            status: aiResult.status,
            ...(aiResult.durationMs !== undefined ? { durationMs: aiResult.durationMs } : {}),
            checks: aiResult.checks.map((c) => ({
              ruleId: c.ruleId,
              status: c.status,
              confidence: c.confidence,
              reason: c.reason,
              ...(c.error ? { error: c.error } : {}),
              evidence: c.evidence,
            })),
            diagnostics: aiResult.diagnostics,
          },
          ruleMerge: mergeRuleResults(report.ruleInventory, aiResult.checks),
        }
        for (const d of aiResult.diagnostics) report.diagnostics.push(`AI 规则检查：${d}`)
      }
    } catch (e) {
      report.diagnostics.push(`AI 规则检查失败（静态结果仍有效）：${String((e as Error)?.message ?? e).slice(0, 200)}`)
    }
  }

  let planner: PlannerOutput | undefined
  let recommendations = report.recommendations
  if (input.includeSuggestions && !input.plannerAgent) {
    report.diagnostics.push("已请求 AI 建议但当前入口未配置 Planner（静态分析结果仍有效）")
  }
  if (input.includeSuggestions && input.plannerAgent) {
    const prompt = buildPlannerPrompt(report)
    try {
      const text = await input.plannerAgent(prompt)
      const parsed = parsePlannerResponse(text)
      if (parsed.ok) {
        planner = parsed.output
        recommendations = mergeRecommendations(report.recommendations, planner)
      } else {
        report.diagnostics.push(`AI 建议校验失败：${parsed.errors.join("; ")}`)
      }
    } catch (e) {
      report.diagnostics.push(`AI 建议调用失败：${String((e as Error)?.message ?? e)}`)
    }
  }

  const finalReport: AnalysisReport = { ...report, recommendations }
  const format = input.format ?? "json"
  const rendered = format === "md" ? renderMarkdown(finalReport) : JSON.stringify(finalReport, null, 2)
  return { ok: true, report: finalReport, recommendations, ...(planner ? { planner } : {}), rendered }
}

/** 核心：所有入口走这里 */
export async function analyzeWorkflow(input: AnalyzeInput): Promise<AnalyzeResult> {
  const cwd = input.cwd ?? process.cwd()
  let source = input.source
  let file = input.scriptPath

  // 目录模式必须最先判断：它既没有 source 也没有 scriptPath
  if (!source && !input.scriptPath && input.dirPath) {
    return analyzeDirectory(input)
  }

  if (!source) {
    if (!file) return { ok: false, error: "需要 scriptPath / dirPath / source 之一" }
    const abs = path.resolve(cwd, file)
    if (!fs.existsSync(abs)) return { ok: false, error: `脚本不存在：${file}` }
    source = fs.readFileSync(abs, "utf8")
  }

  let report = buildReport({
    source,
    ...(file ? { file } : {}),
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
  })

  // 跨文件聚合（默认开）：真实 workflow 常是「壳 + 子流程」，
  // 只分析入口会得出「风险很低」的假象（PrdGameSkill 壳 714 行 / 子流程合计 3513 行）。
  /** AI Rule Check 用的源码集合（入口 + 子流程） */
  let checkSources: Array<{ file: string; content: string }> = [{ file: file ?? "(inline)", content: source }]
  if (file && input.recursive !== false) {
    try {
      const tree = analyzeWorkflowTree({ entryPath: path.resolve(cwd, file) })
      checkSources = tree.sources
      if (tree.subWorkflows.length > 0) {
        // P0 统一口径（2026-11-19）：顶层 findings/ruleInventory/summary 改为 aggregate，
        // entry 明细单独保留。此前 Dashboard 自己合并、Markdown 用入口口径，
        // 导致同一次分析出现「23 条 vs 1 条」两套数字。
        const entryFindings = report.findings
        const entryRuleInventory = report.ruleInventory
        const entrySummary = report.summary

        const subFindings: AnalysisFindingWithSnippet[] = tree.subWorkflows.flatMap((sw) =>
          sw.findings.map((f) => ({
            ruleId: f.ruleId,
            severity: f.severity as Severity,
            confidence: f.confidence,
            location: { file: sw.file, startLine: f.startLine, endLine: f.endLine },
            evidence: f.evidence,
            ...(f.suggestion ? { suggestion: f.suggestion } : {}),
            ...(f.snippet ? { snippet: f.snippet } : {}),
          })),
        )
        const aggregated = [...entryFindings, ...subFindings]
        const counts = { critical: 0, high: 0, medium: 0, low: 0 } as Record<Severity, number>
        for (const f of aggregated) counts[f.severity] += 1

        report = {
          ...report,
          findings: aggregated,
          // 同 analyzeDirectory：聚合后必须重算，否则簇只覆盖入口自身
          clusters: clusterFindings(aggregated),
          summary: { riskScore: entrySummary.riskScore, counts, totalFindings: aggregated.length },
          entry: { findings: entryFindings, ruleInventory: entryRuleInventory, totalFindings: entryFindings.length },
          aggregateRiskScore: tree.aggregate.maxRisk,
          // 规则清单合并子流程命中，否则规则页显示「通过」而子文件实际命中
          ruleInventory: entryRuleInventory.map((r) => {
            const subHits = tree.aggregate.rules[r.id] ?? 0
            return subHits > 0 ? { ...r, hits: r.hits + subHits, status: "hit" as const } : r
          }),
          subtree: {
            files: tree.aggregate.files,
            callSites: tree.aggregate.callSites,
            totalFindings: tree.aggregate.totalFindings,
            maxRisk: tree.aggregate.maxRisk,
            ...(tree.aggregate.riskiest ? { riskiest: tree.aggregate.riskiest } : {}),
            rules: tree.aggregate.rules,
            subWorkflows: tree.subWorkflows.map((sw) => ({
              file: sw.file,
              riskScore: sw.riskScore,
              callSites: sw.callSites,
              totalFindings: sw.totalFindings,
              ...(sw.topRule ? { topRule: sw.topRule } : {}),
              findings: sw.findings,
            })),
          },
        }
      }
    } catch (e) {
      report.diagnostics.push(`子 workflow 聚合失败（入口结果仍有效）：${String((e as Error)?.message ?? e).slice(0, 200)}`)
    }
  }

  // Plan 状态（旧 Workflow 无 Plan 也照常分析，不阻止）
  let planInfo: AnalyzeResult["plan"]
  if (file) {
    const loaded = loadPlan({ scriptPath: file, cwd })
    if (loaded.path) {
      planInfo = { path: loaded.path, stale: loaded.stale, defaultProfile: loaded.defaultProfile, notes: loaded.notes }
    }
  }

  // ---- AI Rule Check（默认开启）----
  // 与下方 Planner 的区别：这里让模型**按 rule.md 独立判定**每条规则，
  // 因此能发现静态正则/AST 看不见的问题（如跨函数数据流、确定性 IO 代理）。
  const wantRuleCheck = input.includeRuleCheck !== false && Boolean(input.ruleCheckAgent)
  if (wantRuleCheck && input.ruleCheckAgent) {
    try {
      const loaded = loadRuleDocs()
      for (const p of loaded.problems) report.diagnostics.push(`规则文档：${p}`)
      // 默认只让 AI 复核「静态判定不可靠」的规则：结构事实类（retries 几、有无 timeoutMs）
      // 静态 100% 准确，交给模型只会变慢且可能数错。--ai-rules all 可全量复核。
      const SEMANTIC_AI_RULES = new Set([
        "CONC-002",
        "SERIAL-002",
        "DET-001",
        "REC-002",
        "BUDGET-001",
        "SIDEFX-001",
      ])
      const aiRules =
        input.aiRules === "all" ? loaded.rules : loaded.rules.filter((r) => SEMANTIC_AI_RULES.has(r.id))
      if (aiRules.length > 0) {
        const staticSummary = [
          `风险分 ${report.summary.riskScore}/100，聚合 ${report.summary.totalFindings} 条 finding，${report.subtree?.files ?? 1} 个文件。`,
          "静态规则结果：" +
            report.ruleInventory
              .map((r) => `${r.id}=${r.status === "error" ? "error" : r.hits > 0 ? `hit(${r.hits})` : "pass"}`)
              .join(", "),
          ...report.findings.slice(0, 12).map(
            (f) => `- ${f.ruleId} ${f.severity} ${f.location.file ?? "(entry)"}:${f.location.startLine}-${f.location.endLine} ${f.evidence[0] ?? ""}`,
          ),
        ].join("\n")
        const aiResult = await runAIRuleCheck({
          rules: aiRules,
          sources: toSourceFiles(checkSources),
          staticSummary,
          plannerAgent: input.ruleCheckAgent,
        })
        report = {
          ...report,
          aiRuleCheck: {
            status: aiResult.status,
            ...(aiResult.durationMs !== undefined ? { durationMs: aiResult.durationMs } : {}),
            checks: aiResult.checks.map((c) => ({
              ruleId: c.ruleId,
              status: c.status,
              confidence: c.confidence,
              reason: c.reason,
              ...(c.error ? { error: c.error } : {}),
              evidence: c.evidence,
            })),
            diagnostics: aiResult.diagnostics,
          },
          ruleMerge: mergeRuleResults(report.ruleInventory, aiResult.checks),
        }
        for (const d of aiResult.diagnostics) report.diagnostics.push(`AI 规则检查：${d}`)
      }
    } catch (e) {
      report.diagnostics.push(`AI 规则检查失败（静态结果仍有效）：${String((e as Error)?.message ?? e).slice(0, 200)}`)
    }
  }

  // AI 建议（可选）
  let planner: PlannerOutput | undefined
  let recommendations = report.recommendations
  if (input.includeSuggestions && !input.plannerAgent) {
    report.diagnostics.push("已请求 AI 建议但当前入口未配置 Planner（静态分析结果仍有效）")
  }
  if (input.includeSuggestions && input.plannerAgent) {
    // 不传源码片段：2026-11-19 实测 4000 字符源码会让模型 120s+ 零响应（见 buildPlannerPrompt 注释）
    const prompt = buildPlannerPrompt(report)
    try {
      const text = await input.plannerAgent(prompt)
      const parsed = parsePlannerResponse(text)
      if (parsed.ok) {
        planner = parsed.output
        recommendations = mergeRecommendations(report.recommendations, planner)
      } else {
        report.diagnostics.push(`AI 建议校验失败：${parsed.errors.join("; ")}`)
      }
    } catch (e) {
      report.diagnostics.push(`AI 建议调用失败：${String((e as Error)?.message ?? e)}`)
    }
  }

  const finalReport: AnalysisReport = { ...report, recommendations }
  const format = input.format ?? "json"
  const rendered = format === "md" ? renderMarkdown(finalReport) : JSON.stringify(finalReport, null, 2)

  let reportPath: string | undefined
  if (input.writeReport && file) {
    const base = path.basename(file).replace(/\.(m?js)$/, "")
    const dir = path.join(cwd, ".pi", "workflows", "reports")
    fs.mkdirSync(dir, { recursive: true })
    reportPath = path.join(dir, `${base}.analysis.json`)
    fs.writeFileSync(reportPath, JSON.stringify(finalReport, null, 2), "utf8")
    fs.writeFileSync(path.join(dir, `${base}.analysis.md`), renderMarkdown(finalReport), "utf8")
  }

  return {
    ok: true,
    report: finalReport,
    recommendations,
    ...(planner ? { planner } : {}),
    ...(planInfo ? { plan: planInfo } : {}),
    rendered,
    ...(reportPath ? { reportPath } : {}),
  }
}

/**
 * 从 `<cwd>/.pi/workflows/model-tiers.json` 解析 tier 对应的模型串。
 *
 * 为什么需要：analyzer 此前完全不读 model-tiers，`PiAgentAdapter` 直接落到宿主
 * settings.json 的 defaultModel。实测该默认是 reasoning 模型（glm-5.3-flash），
 * 单条规则要 90~97s；而 tiers.fast（deepseek-v4.1-flash，reasoning=false）只要 14s，
 * 结论质量相当。这是"AI 规则检查慢/超时"的真正根因。
 */
export function resolveTierModel(tier: string, cwd?: string): string | undefined {
  try {
    const tiers = loadModelTiers({ projectDir: cwd ?? process.cwd() })
    const entry = tiers[tier]
    if (typeof entry === "string") return entry
    if (Array.isArray(entry) && entry[0]?.model) return entry[0].model
    // 用户决策（2026-11-19）：解析不到档位时告警 + 回退会话默认，不阻断分析。
    // 必须告警——静默回退会让人以为在用 fast，实际可能在用很慢的 reasoning 模型。
    console.warn(
      `[pi-code-mode] 档位 "${tier}" 未在 model-tiers.json 中配置（查找路径：${cwd ?? process.cwd()}/.pi/workflows/model-tiers.json），已回退会话默认模型`,
    )
  } catch (e) {
    console.warn(`[pi-code-mode] 读取 model-tiers.json 失败，已回退会话默认模型：${String((e as Error)?.message ?? e)}`)
  }
  return undefined
}

/**
 * 构造真实 Planner agent（M6-P1-3 接线）：用 PiAgentAdapter 跑一次性分析调用。
 *
 * 模型优先级：显式 `model` > `tier`（默认 "fast"，从 model-tiers.json 解析）> 会话默认。
 * 实测（REC-002，prompt 20k 字符）：fast tier 14.1s / big tier 89.6s / 会话默认 glm 97s。
 *
 * 默认超时 240s：覆盖慢模型的尾部波动；fast tier 下通常 15~40s。
 */
export function createPlannerAgent(
  options: { cwd?: string; agentDir?: string; model?: string; tier?: string; timeoutMs?: number } = {},
) {
  // 解析一次（避免每次调用都读配置文件）
  const tier = options.tier ?? "fast"
  const resolvedModel = options.model ?? resolveTierModel(tier, options.cwd)
  return async (prompt: string): Promise<string> => {
    // 与项目其他模块一致用静态 import：jiti 直载 TS 源码时，动态 import "*.js" 可能解析失败

    const adapter = new PiAgentAdapter({
      ...(options.agentDir ? { agentDir: options.agentDir } : {}),
      ...(options.cwd ? { defaultCwd: options.cwd } : {}),
    })
    // 注意：AgentRequest.timeoutMs 当前未被 PiAgentAdapter 消费（只认 signal），
    // 因此必须用 AbortController 施加真实超时——否则模型调用挂住会让调用方永久静默等待。
    // 按档位给默认超时：分析类（big/ultra）允许到 10 分钟，执行类（fast）240s 够用。
    // 用户决策（2026-11-20）：big 用来看代码分析，慢一点可接受；fast 用来改代码，要快。
    const tierDefaultTimeout = /^(big|ultra)$/i.test(tier) ? 600_000 : 240_000
    const timeoutMs = options.timeoutMs ?? tierDefaultTimeout
    const controller = new AbortController()
    const executionId = `analyze-planner-${Date.now()}`

    // 关键：用 Promise.race 施加调用方超时，而不是“abort 后等底层收尾”。
    // 底层 session.abort() 在极端情况可能不返回；一旦 await 它，命令就会重新挂住。
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        // 不 await：清理是尽力而为，绝不能阻塞命令返回
        void adapter.cancel(executionId).catch(() => {})
        reject(new Error(`Planner 调用超时（${timeoutMs}ms）`))
      }, timeoutMs)
    })

    try {
      const execution = adapter.execute(
        {
          prompt,
          ...(resolvedModel ? { model: resolvedModel } : {}),
          signal: controller.signal,
        },
        { executionId, runId: "", phase: "analyzer" },
      )
      const result = await Promise.race([execution, timeout])
      if (result.status !== "ok") {
        throw new Error(`Planner 调用失败（${result.status}）：${result.error?.message ?? "unknown"}`)
      }
      return String(result.output.value ?? "")
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

/** Pi 工具工厂 */
export function createWorkflowAnalyzeTool(deps: {
  cwd?: string
  plannerAgent?: (prompt: string) => Promise<string>
}) {
  return {
    name: "workflow_analyze",
    label: "Analyze Workflow",
    description:
      "静态分析 workflow 脚本：调用图、依赖置信度、性能风险、执行估算、优化建议。可选 AI 深度建议（includeSuggestions）。不执行脚本。",
    parameters: Type.Object({
      scriptPath: Type.Optional(Type.String({ description: "脚本路径（相对项目根）" })),
      source: Type.Optional(Type.String({ description: "内联脚本源码（与 scriptPath 二选一）" })),
      includeSuggestions: Type.Optional(Type.Boolean({ description: "附带 AI 优化建议（需模型，较慢）" })),
      format: Type.Optional(Type.Union([Type.Literal("json"), Type.Literal("md")], { description: "输出格式，缺省 json" })),
      writeReport: Type.Optional(Type.Boolean({ description: "写入 .pi/workflows/reports/（缺省 false）" })),
    }),
    async execute(_id: string, params: any) {
      const result = await analyzeWorkflow({
        ...(params.scriptPath ? { scriptPath: params.scriptPath } : {}),
        ...(params.source ? { source: params.source } : {}),
        includeSuggestions: params.includeSuggestions === true,
        ...(deps.plannerAgent ? { plannerAgent: deps.plannerAgent } : {}),
        format: params.format === "md" ? "md" : "json",
        writeReport: params.writeReport === true,
        cwd: deps.cwd,
      })
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: `分析失败：${result.error}` }], isError: true }
      }
      const summary = [
        `风险分 ${result.report!.summary.riskScore}/100`,
        `调用点 ${result.report!.executionEstimate.callSites}`,
        `finding ${result.report!.summary.totalFindings} 条`,
        ...(result.plan?.stale ? ["Plan 已过期，需重新分析"] : []),
      ].join(" · ")
      return {
        content: [{ type: "text" as const, text: `${summary}\n\n${result.rendered ?? ""}${result.reportPath ? `\n\n报告已写入：${result.reportPath}` : ""}` }],
      }
    },
  }
}

/**
 * Pi 工具：workflow_benchmark（M6/4）
 *
 * 真实跑 before/after 两轮（由调用方注入 runOnce，通常复用 workflow 工具），
 * 从 Plan 提取 Required Validation 并判定质量是否降级。不虚构收益。
 */
export function createWorkflowBenchmarkTool(deps: {
  cwd?: string
  /** 执行一轮（真实实现：调 workflow 工具；测试可注入 fake） */
  runOnce?: (input: { scriptPath: string; label: "before" | "after"; cwd: string }) => Promise<{
    durationMs: number
    agents?: number
    inputTokens?: number
    outputTokens?: number
    failedAgents?: number
    validation?: { passed: string[]; failed: string[] }
    ok: boolean
    error?: string
  }>
}) {
  return {
    name: "workflow_benchmark",
    label: "Benchmark Workflow",
    description:
      "对 workflow 跑 before/after 真实对照：从 Plan 提取强制验证项，判定是否有改善且质量未降级。未提供 runOnce 时返回明确错误（不伪造数据）。",
    parameters: Type.Object({
      scriptPath: Type.String({ description: "优化前脚本路径（相对项目根）" }),
      afterScriptPath: Type.Optional(Type.String({ description: "优化后脚本路径（工作区脚本，用于真实 before/after 对照）" })),
      planPath: Type.Optional(Type.String({ description: "Plan 路径（提供则做 Required Validation 校验）" })),
      profile: Type.Optional(Type.String({ description: "Profile 名（fast/balanced/quality）" })),
    }),
    async execute(_id: string, params: any) {
      const cwd = deps.cwd ?? process.cwd()
      if (!deps.runOnce) {
        return {
          content: [
            { type: "text" as const, text: "未配置 benchmark 执行器：需要注入 runOnce（复用 workflow 工具执行真实 run），否则不会伪造数据。" },
          ],
          isError: true,
        }
      }
      const loaded = params.planPath ? loadPlan({ scriptPath: params.scriptPath, cwd, explicitPath: params.planPath }) : { plan: null }
      const result = await runBenchmark({
        ...(loaded.plan ? { plan: loaded.plan } : {}),
        ...(params.profile ? { mode: params.profile } : {}),
        runOnce: (label) => deps.runOnce!({ scriptPath: params.scriptPath, label, cwd }),
      })
      const body = `${renderBenchmark(result)}

\`\`\`json
${JSON.stringify(toEvaluation(result, { runId: `bench-${Date.now()}` }), null, 2).slice(0, 1200)}
\`\`\``
      return { content: [{ type: "text" as const, text: body }], ...(result.accepted ? {} : { isError: false }) }
    },
  }
}

/** Pi 工具：workflow_optimize（真实接线；默认只在独立工作区建议，不自动改生产） */
export function createWorkflowOptimizeTool(deps: {
  cwd?: string
  plannerAgent?: (prompt: string) => Promise<string>
  /** 可选：授权后的安全 patch 生成器；缺省只生成建议，不猜测整文件 patch */
  patchSource?: (input: { source: string; proposals: unknown[]; workspacePath: string }) => Promise<string | undefined>
}) {
  return {
    name: "workflow_optimize",
    label: "Optimize Workflow",
    description:
      "分析 Workflow 并在独立工作区生成优化修改，重新分析/Benchmark 后等待授权。默认不修改生产脚本。",
    parameters: Type.Object({
      scriptPath: Type.String({ description: "workflow 脚本路径（相对项目根）" }),
      approve: Type.Optional(Type.Boolean({ description: "显式授权应用修改；缺省 false（安全默认）" })),
    }),
    async execute(_id: string, params: any) {
      const cwd = deps.cwd ?? process.cwd()
      const result = await runOptimizationLoop({
        scriptPath: params.scriptPath,
        cwd,
        analyze: async (scriptPath) => {
          const r = await analyzeWorkflow({ scriptPath, cwd })
          if (!r.report) throw new Error(r.error ?? "分析失败")
          return r.report
        },
        propose: async ({ report, source }) => {
          if (!deps.plannerAgent) return { recommendations: report.recommendations }
          const prompt = buildPlannerPrompt(report)
          const parsed = parsePlannerResponse(await deps.plannerAgent(prompt))
          if (!parsed.ok || !parsed.output) return { recommendations: report.recommendations }
          const merged = mergeRecommendations(report.recommendations, parsed.output)
          // codeSketch 是局部片段，不能冒充完整文件 patch；只有显式 patchSource 才允许进入闭环应用
          const patchedSource = deps.patchSource
            ? await deps.patchSource({ source, proposals: parsed.output.proposals, workspacePath: "" })
            : undefined
          return { recommendations: merged, ...(patchedSource !== undefined ? { patchedSource } : {}) }
        },
        // M6 接线第一版不自动执行 benchmark；没有 after 证据则仍不应用（优化闭环安全默认）
        dangerouslyAutoApprove: params.approve === true,
      })
      return { content: [{ type: "text" as const, text: renderLoopResult(result) }], ...(result.ok ? {} : { isError: false }) }
    },
  }
}

/** CLI：optimize（默认只分析并输出建议；不自动修改生产脚本） */
export async function runOptimizeCli(argv: string[]): Promise<number> {
  const target = argv.find((a) => !a.startsWith("--"))
  if (!target) {
    console.error("用法：pi-code-mode optimize <script> [--apply]")
    return 2
  }
  const result = await analyzeWorkflow({ scriptPath: target, format: "md", includeSuggestions: argv.includes("--suggest") })
  if (!result.ok) {
    console.error(`优化分析失败：${result.error}`)
    return 1
  }
  console.log(result.rendered)
  console.log("\\n安全默认：仅生成分析与建议；修改必须在独立工作区经 Benchmark 与用户确认后应用。")
  return 0
}

/** CLI 实现（pi-code-mode analyze） */
export async function runAnalyzeCli(argv: string[]): Promise<number> {
  const args = [...argv]
  const flags = new Set(args.filter((a) => a.startsWith("--")))
  const target = args.find((a) => !a.startsWith("--"))
  if (!target) {
    console.error("用法：pi-code-mode analyze <script> [--json|--md] [--suggest] [--write]")
    return 2
  }
  const result = await analyzeWorkflow({
    scriptPath: target,
    format: flags.has("--md") ? "md" : "json",
    writeReport: flags.has("--write"),
    // CLI 不默认调模型（--suggest 由外部接线注入 plannerAgent）
  })
  if (!result.ok) {
    console.error(`分析失败：${result.error}`)
    return 1
  }
  console.log(result.rendered)
  if (result.plan?.stale) console.error("提示：Plan 已过期（source.scriptHash 不匹配）")
  return 0
}
