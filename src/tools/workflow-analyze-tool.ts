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

import { buildReport, renderMarkdown, type AnalysisReport } from "../engine/analyzer/report-builder.js"
import {
  buildPlannerPrompt,
  mergeRecommendations,
  parsePlannerResponse,
  type PlannerOutput,
} from "../engine/analyzer/optimization-planner.js"
import { loadPlan } from "../engine/plan/plan-loader.js"

export interface AnalyzeInput {
  /** 脚本路径（与 source 二选一） */
  scriptPath?: string
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

/** 核心：所有入口走这里 */
export async function analyzeWorkflow(input: AnalyzeInput): Promise<AnalyzeResult> {
  const cwd = input.cwd ?? process.cwd()
  let source = input.source
  let file = input.scriptPath

  if (!source) {
    if (!file) return { ok: false, error: "需要 scriptPath 或 source 之一" }
    const abs = path.resolve(cwd, file)
    if (!fs.existsSync(abs)) return { ok: false, error: `脚本不存在：${file}` }
    source = fs.readFileSync(abs, "utf8")
  }

  const report = buildReport({
    source,
    ...(file ? { file } : {}),
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
  })

  // Plan 状态（旧 Workflow 无 Plan 也照常分析，不阻止）
  let planInfo: AnalyzeResult["plan"]
  if (file) {
    const loaded = loadPlan({ scriptPath: file, cwd })
    if (loaded.path) {
      planInfo = { path: loaded.path, stale: loaded.stale, defaultProfile: loaded.defaultProfile, notes: loaded.notes }
    }
  }

  // AI 建议（可选）
  let planner: PlannerOutput | undefined
  let recommendations = report.recommendations
  if (input.includeSuggestions && input.plannerAgent) {
    const snippet = file ? extractSnippet(source, report) : undefined
    const prompt = buildPlannerPrompt(report, { ...(snippet ? { codeSnippet: snippet } : {}) })
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

/** 抽取 finding 附近代码片段（控制 prompt 体积，不塞整文件） */
function extractSnippet(source: string, report: AnalysisReport, contextLines = 12): string {
  const lines = source.split("\n")
  const ranges = report.findings.slice(0, 5).map((f) => [Math.max(1, f.location.startLine - 3), Math.min(lines.length, f.location.endLine + 3)])
  const picked = new Set<number>()
  for (const [a, b] of ranges) for (let i = a; i <= b && i - a < contextLines * 2; i++) picked.add(i)
  return [...picked]
    .sort((x, y) => x - y)
    .map((n) => `${String(n).padStart(4)}| ${lines[n - 1] ?? ""}`)
    .join("\n")
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
