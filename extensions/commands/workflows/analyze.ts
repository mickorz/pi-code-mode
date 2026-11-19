/**
 * /workflows analyze 子命令（别名 anal）：在 pi 会话内直接静态分析 workflow 脚本。
 *
 * 复用 Analyzer Core（analyzeWorkflow）——与 workflow_analyze 工具、CLI 同一实现，无重复逻辑。
 *
 * 用法：
 *   /workflows analyze <脚本路径|注册表名> [--no-suggest] [--json]
 *
 * AI 优化建议默认开启（用户预期：分析就该给建议，不用额外加 flag）；
 * 想省 token 时用 --no-suggest。
 *
 * 输出策略（报告常达数百行，notify 会被截断）：
 *   - 完整报告落盘 .pi/workflows/reports/<name>.analysis.{md,json}
 *   - 会话内 notify 只给摘要：风险分 / 调用结构 / findings 前若干条 / 报告路径
 */

import fs from "node:fs"
import path from "node:path"

import { analyzeWorkflow, createPlannerAgent } from "../../../src/tools/workflow-analyze-tool.js"
import { validatePlanFile } from "../../../src/tools/plan-tool.js"
import { loadRegistry, readWorkflowScript } from "../../../src/engine/runtime/workflow-registry.js"
import type { Subcommand } from "./types.js"

const REPORT_DIR = path.join(".pi", "workflows", "reports")
/** 会话摘要里最多展示的 finding 条数（完整报告看文件） */
const SUMMARY_FINDINGS = 6

function resolveScript(cwd: string, ref: string): { source: string; label: string } | string {
  // 注册表名与路径都支持，与 /workflows run 语义一致
  try {
    const registry = loadRegistry(cwd)
    if (registry.has(ref)) {
      return { source: readWorkflowScript(cwd, ref), label: `registry:${ref}` }
    }
  } catch {
    /* registry 缺失时按路径处理 */
  }
  const abs = path.resolve(cwd, ref)
  if (!fs.existsSync(abs)) return `找不到脚本：${ref}（相对项目根 ${cwd} 解析）`
  return { source: fs.readFileSync(abs, "utf8"), label: ref }
}

function renderSummary(input: {
  scriptPath: string
  riskScore: number
  callSites: number
  estimatedTasks: number
  determined: boolean
  dynamicNodes: number
  waves?: number
  concurrency?: number
  findings: Array<{ ruleId: string; severity: string; confidence: number; location: { startLine: number; endLine: number }; evidence: string[] }>
  totalFindings: number
  recommends: number
  /** AI 建议条数（未开启时为 undefined） */
  aiRecommends?: number
  reportPath?: string
  diagnostics: string[]
}): string {
  const lines: string[] = []
  lines.push(`Analyzer: ${input.scriptPath}`)
  lines.push(`风险分 ${input.riskScore}/100`)
  lines.push(
    `调用点 ${input.callSites}（估算任务 ${input.estimatedTasks}${input.determined ? "" : "，含动态为下限"}）` +
      (input.dynamicNodes > 0 ? ` · 动态节点 ${input.dynamicNodes}` : "") +
      (input.waves !== undefined ? ` · 预计 ${input.waves} 波次` : ""),
  )

  if (input.findings.length === 0) {
    lines.push("未发现静态风险。")
  } else {
    lines.push("")
    for (const f of input.findings.slice(0, SUMMARY_FINDINGS)) {
      lines.push(`[${f.severity.toUpperCase()}] ${f.ruleId} L${f.location.startLine}-${f.location.endLine} (conf ${f.confidence.toFixed(2)})`)
      if (f.evidence[0]) lines.push(`  ${f.evidence[0].slice(0, 120)}`)
    }
    if (input.totalFindings > SUMMARY_FINDINGS) {
      lines.push(`…另有 ${input.totalFindings - SUMMARY_FINDINGS} 条，见报告文件`)
    }
  }
  if (input.recommends > 0) lines.push(`\n优化建议 ${input.recommends} 条（expectedImpact 一律「待 Benchmark」，不虚构数值）`)
  if (input.diagnostics.length > 0) lines.push(`\n诊断：${input.diagnostics.slice(0, 3).join("；")}`)
  if (input.reportPath) lines.push(`\n完整报告：${input.reportPath}`)
  return lines.join("\n")
}

export const analyzeSubcommand: Subcommand = {
  usage: "analyze <路径|名> [--no-suggest] [--json]  静态分析+AI建议（别名 anal；报告落盘）",
  async run(argv, ctx, deps) {
    const cwd = ctx.cwd ?? process.cwd()
    const flags = new Set(argv.filter((a) => a.startsWith("--")))
    const ref = argv.find((a) => !a.startsWith("--"))
    if (!ref) {
      ctx.ui.notify("用法: /workflows analyze <脚本路径|注册表名> [--no-suggest] [--json]", "warning")
      return
    }

    const resolved = resolveScript(cwd, ref)
    if (typeof resolved === "string") {
      ctx.ui.notify(resolved, "warning")
      return
    }

    // AI 优化建议默认开启（--no-suggest 可关；会真实调用模型，耗 token）
    const withSuggestions = !flags.has("--no-suggest")
    // 先给即时反馈：AI 建议要等模型返回，静默等待会让人以为命令没生效
    ctx.ui.notify(withSuggestions ? `分析中（含 AI 建议，最长 60s）…
${ref}` : `分析中…
${ref}`, "info")
    const result = await analyzeWorkflow({
      source: resolved.source,
      ...(ref.startsWith("registry:") ? {} : { scriptPath: ref }),
      cwd,
      includeSuggestions: withSuggestions,
      ...(withSuggestions ? { plannerAgent: createPlannerAgent({ cwd }) } : {}),
      format: flags.has("--json") ? "json" : "md",
    })

    if (!result.ok || !result.report) {
      ctx.ui.notify(`分析失败：${result.error ?? "unknown"}`, "warning")
      return
    }

    // 完整报告落盘（会话摘要无法承载数百行）
    let reportPath: string | undefined
    try {
      const dir = path.join(cwd, REPORT_DIR)
      fs.mkdirSync(dir, { recursive: true })
      const base = path.basename(ref, path.extname(ref))
      const mdPath = path.join(dir, `${base}.analysis.md`)
      fs.writeFileSync(mdPath, result.rendered ?? "", "utf8")
      fs.writeFileSync(path.join(dir, `${base}.analysis.json`), JSON.stringify(result.report, null, 2), "utf8")
      reportPath = path.relative(cwd, mdPath)
    } catch (e) {
      ctx.ui.notify(`报告落盘失败（分析结果仍有效）：${String((e as Error)?.message ?? e)}`, "warning")
    }

    const r = result.report
    const summary = renderSummary({
      scriptPath: result.plan ? `${ref}（Plan: ${result.plan.path}${result.plan.stale ? "，已过期" : ""}）` : ref,
      riskScore: r.summary.riskScore,
      callSites: r.executionEstimate.callSites,
      estimatedTasks: r.executionEstimate.estimatedTasks,
      determined: r.executionEstimate.determined,
      dynamicNodes: r.executionEstimate.dynamicNodes,
      ...(r.executionEstimate.estimatedWaves !== undefined ? { waves: r.executionEstimate.estimatedWaves } : {}),
      ...(r.executionEstimate.concurrency !== undefined ? { concurrency: r.executionEstimate.concurrency } : {}),
      findings: r.findings.map((f) => ({
        ruleId: f.ruleId,
        severity: f.severity,
        confidence: f.confidence,
        location: f.location,
        evidence: f.evidence,
      })),
      totalFindings: r.summary.totalFindings,
      recommends: r.recommendations.length,
      ...(result.planner ? { aiRecommends: result.planner.proposals.length } : {}),
      ...(reportPath ? { reportPath } : {}),
      diagnostics: r.diagnostics,
    })
    ctx.ui.notify(summary, "info")
    void deps
  },
}

/** /workflows plan validate <plan.json>：Plan 校验（Schema/Profile 边界/指纹/过期） */
export const planSubcommand: Subcommand = {
  usage: "plan validate <plan.json>         校验 Plan（Profile 边界/指纹/过期）",
  async run(argv, ctx, deps) {
    const cwd = ctx.cwd ?? process.cwd()
    const action = argv[0]
    const planPath = argv.slice(1).find((a) => !a.startsWith("--"))
    if (action !== "validate" || !planPath) {
      ctx.ui.notify("用法: /workflows plan validate <plan.json>", "warning")
      return
    }
    const r = validatePlanFile({ planPath, cwd })
    ctx.ui.notify(r.rendered, r.ok ? "info" : "warning")
    void deps
  },
}
