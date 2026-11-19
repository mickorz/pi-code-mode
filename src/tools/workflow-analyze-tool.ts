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
import { PiAgentAdapter } from "../adapter/pi-agent-adapter.js"
import { runOptimizationLoop, renderLoopResult } from "../engine/evaluator/optimization-loop.js"
import { runBenchmark, renderBenchmark, toEvaluation } from "../engine/evaluator/benchmark-runner.js"

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
  if (input.includeSuggestions && !input.plannerAgent) {
    report.diagnostics.push("已请求 AI 建议但当前入口未配置 Planner（静态分析结果仍有效）")
  }
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

/**
 * 构造真实 Planner agent（M6-P1-3 接线）：用 PiAgentAdapter 跑一次性分析调用。
 * 审计发现此前 includeSuggestions:true 静默无效（未注入 plannerAgent）。
 */
export function createPlannerAgent(options: { cwd?: string; agentDir?: string; model?: string; timeoutMs?: number } = {}) {
  return async (prompt: string): Promise<string> => {
    // 与项目其他模块一致用静态 import：jiti 直载 TS 源码时，动态 import "*.js" 可能解析失败

    const adapter = new PiAgentAdapter({
      ...(options.agentDir ? { agentDir: options.agentDir } : {}),
      ...(options.cwd ? { defaultCwd: options.cwd } : {}),
    })
    // 注意：AgentRequest.timeoutMs 当前未被 PiAgentAdapter 消费（只认 signal），
    // 因此必须用 AbortController 施加真实超时——否则模型调用挂住会让调用方永久静默等待。
    const timeoutMs = options.timeoutMs ?? 60_000
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
          ...(options.model ? { model: options.model } : {}),
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
          const prompt = buildPlannerPrompt(report, { codeSnippet: source.slice(0, 4000) })
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
