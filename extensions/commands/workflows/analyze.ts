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
import { writeDashboard } from "../../../src/engine/analyzer/dashboard/build-dashboard.js"
import { openInBrowser, shouldAutoOpen } from "../../../src/utils/open-browser.js"
import { validatePlanFile } from "../../../src/tools/plan-tool.js"
import { loadRegistry, readWorkflowScript } from "../../../src/engine/runtime/workflow-registry.js"
import type { Subcommand } from "./types.js"

const REPORT_DIR = path.join(".pi", "workflows", "reports")
/** 会话摘要里最多展示的 finding 条数（完整报告看文件） */
const SUMMARY_FINDINGS = 6

/**
 * 解析分析目标：注册表名 / 文件 / **目录**（目录自动找入口）。
 *
 * 目录形态的必要性：真实 workflow 是「入口壳 + 同目录子流程」结构，
 * 用户很自然地传目录（如 `.../game-requirement-audit`）。
 * 此前直接 `readFileSync(目录)` 抛 EISDIR，堆栈完全无法理解。
 */
interface ResolvedScript {
  /** 入口文件内容；目录模式无入口，为 undefined（走 dirPath 由 analyzeWorkflow 读目录下全部 js） */
  source?: string
  label: string
  /** 解析后的实际文件路径（单文件模式），供 analyzeWorkflow 的 tree 聚合使用 */
  filePath?: string
  /** 目录模式：该目录下全部 .js 都要分析 */
  dirPath?: string
}

function resolveScript(cwd: string, ref: string): ResolvedScript | string {
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

  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch (e) {
    return `无法访问 ${ref}：${String((e as Error)?.message ?? e)}`
  }

  if (stat.isDirectory()) {
    return resolveFromDirectory(abs, ref)
  }
  return { source: fs.readFileSync(abs, "utf8"), label: ref, filePath: abs }
}

/**
 * 目录模式：分析目录下**全部 .js**（用户语义：传文件夹就分析文件夹里的所有脚本）。
 * 返回 files 列表，由 analyzeWorkflow({ dirPath }) 统一做聚合与 AI 阶段。
 */
function resolveFromDirectory(dir: string, ref: string): ResolvedScript | string {
  let names: string[] = []
  try {
    names = fs.readdirSync(dir).filter((n) => /.(m?js)$/.test(n)).sort()
  } catch (e) {
    return `目录不可读：${ref}（${String((e as Error)?.message ?? e)}）`
  }
  if (names.length === 0) return `目录下没有 .js 文件：${ref}`
  // dirPath 交给 analyzeWorkflow 读文件并聚合；这里只做存在性/清单校验，避免重复读盘
  return { label: ref, dirPath: dir }
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
  /** Dashboard 路径：并入摘要（单独发一条通知会把核心结论挤掉） */
  dashboardPath?: string
  diagnostics: string[]
  subtree?: { files: number; callSites: number; maxRisk: number; riskiest?: string; totalFindings: number }
}): string {
  const lines: string[] = []
  lines.push(`Analyzer: ${input.scriptPath}`)
  lines.push(`风险分 ${input.riskScore}/100`)
  lines.push(
    `调用点 ${input.callSites}（估算任务 ${input.estimatedTasks}${input.determined ? "" : "，含动态为下限"}）` +
      (input.dynamicNodes > 0 ? ` · 动态节点 ${input.dynamicNodes}` : "") +
      (input.waves !== undefined ? ` · 预计 ${input.waves} 波次` : ""),
  )

  if (input.subtree && input.subtree.files > 1) {
    lines.push(
      `跨文件聚合：${input.subtree.files} 个文件 · ${input.subtree.callSites} 个调用点 · ${input.subtree.totalFindings} 条 finding · 最高风险 ${input.subtree.maxRisk}/100${input.subtree.riskiest ? `（${input.subtree.riskiest}）` : ""}`,
    )
  }

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
  if (input.recommends > 0) lines.push(`\n静态建议 ${input.recommends} 条（expectedImpact 一律「待 Benchmark」，不虚构数值）`)
  if (input.diagnostics.length > 0) lines.push(`\n诊断：${input.diagnostics.slice(0, 3).join("；")}`)
  if (input.reportPath) lines.push(`\n完整报告：${input.reportPath}`)
  if (input.dashboardPath) lines.push(`Dashboard：${input.dashboardPath}`)
  return lines.join("\n")
}

export const analyzeSubcommand: Subcommand = {
  usage: "analyze <路径|名> [--tier fast] [--model 供应商/模型] [--no-suggest] [--no-rule-check] [--ai-rules-all] [--no-open]  静态+AI规则检查+Dashboard（别名 anal）",
  async run(argv, ctx, deps) {
    try {
      await runAnalyze(argv, ctx, deps)
    } catch (e) {
      // 任何异常都必须让用户看到：命令 handler 静默抛错等于“没有任何反应”
      ctx.ui.notify(`分析失败：${String((e as Error)?.stack ?? e).slice(0, 600)}`, "warning")
    }
  },
}

async function runAnalyze(argv: string[], ctx: any, deps: any): Promise<void> {
  {
    const cwd = ctx.cwd ?? process.cwd()
    const flags = new Set(argv.filter((a) => a.startsWith("--")))
    const ref = argv.find((a) => !a.startsWith("--"))
    if (!ref) {
      ctx.ui.notify("用法: /workflows analyze <脚本路径|注册表名> [--no-suggest] [--no-open]", "warning")
      return
    }

    const resolved = resolveScript(cwd, ref)
    if (typeof resolved === "string") {
      ctx.ui.notify(resolved, "warning")
      return
    }

    // AI 优化建议默认开启（--no-suggest 可关；会真实调用模型，耗 token）
    const withSuggestions = !flags.has("--no-suggest")
    ctx.ui.notify(`分析中…
${ref}`, "info")

    // 两段式：静态结果先出（毫秒级），AI 建议随后单独推送。
    // 这样模型慢/超时也不影响用户看到核心结论（历史问题：默认含 AI 时整体要等满超时）。
    // AI Rule Check / AI 建议都在第二阶段执行：静态结果先出（百毫秒级），
    // 否则用户要等 4~6 分钟才看到任何东西（实测 9 条规则 AI 复核约 5 分钟）。
    const withRuleCheck = !flags.has("--no-rule-check")
    // 模型选择：--model 显式指定 > --tier 档位 > model-tiers 的 fast 档 > 会话默认
    // 实测：fast 档（非 reasoning）比会话默认的 reasoning 模型快 7 倍且结论相当
    const argOf = (name: string): string | undefined => {
      const i = argv.indexOf(name)
      return i >= 0 ? argv[i + 1] : undefined
    }
    const modelOpts = {
      ...(argOf("--model") ? { model: argOf("--model")! } : {}),
      ...(argOf("--tier") ? { tier: argOf("--tier")! } : {}),
    }
    let result = await analyzeWorkflow({
      source: resolved.source,
      // 目录模式走 dirPath（分析全部 js）；单文件用解析后的真实路径（传目录时若把目录当 scriptPath，tree 聚合会 readFileSync(目录) 抛 EISDIR）
      ...(ref.startsWith("registry:") ? {} : resolved.dirPath ? { dirPath: resolved.dirPath } : { scriptPath: resolved.filePath ?? ref }),
      cwd,
      includeSuggestions: false,
      includeRuleCheck: false,
      format: flags.has("--json") ? "json" : "md",
    })

    if (!result.ok || !result.report) {
      ctx.ui.notify(`分析失败：${result.error ?? "unknown"}`, "warning")
      return
    }

    // 完整报告落盘（会话摘要无法承载数百行）
    const written = writeReports(cwd, ref, result, { aiEnabled: withSuggestions })
    let reportPath = written.mdPath
    let dashboardPath = written.dashboardPath

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
      ...(dashboardPath ? { dashboardPath } : {}),
      diagnostics: r.diagnostics,
      ...(r.subtree
        ? {
            subtree: {
              files: r.subtree.files,
              callSites: r.subtree.callSites,
              maxRisk: r.subtree.maxRisk,
              ...(r.subtree.riskiest ? { riskiest: r.subtree.riskiest } : {}),
              totalFindings: r.subtree.totalFindings,
            },
          }
        : {}),
    })
    ctx.ui.notify(summary, "info")

    if (withSuggestions || withRuleCheck) {
      // AI 阶段：失败/超时只提示，不影响已给出的静态结论
      try {
        const ai = await analyzeWorkflow({
          source: resolved.source,
          ...(ref.startsWith("registry:") ? {} : resolved.dirPath ? { dirPath: resolved.dirPath } : { scriptPath: resolved.filePath ?? ref }),
          cwd,
          includeSuggestions: withSuggestions,
          ...(withSuggestions ? { plannerAgent: createPlannerAgent({ cwd, ...modelOpts }) } : {}),
          includeRuleCheck: withRuleCheck,
          ...(withRuleCheck ? { ruleCheckAgent: createPlannerAgent({ cwd, ...modelOpts }) } : {}),
          ...(flags.has("--ai-rules-all") ? { aiRules: "all" as const } : {}),
          format: "md",
        })
        const rc = ai.report?.aiRuleCheck
        const ruleCheckSummary = rc
          ? `AI 规则检查 ${rc.status === "completed" ? "全部完成" : rc.status === "partial" ? "部分完成" : "失败"}` +
            `（${rc.checks.filter((c) => c.status === "hit").length} 命中 / ` +
            `${rc.checks.filter((c) => c.status === "uncertain").length} 待确认 / ` +
            `${rc.checks.filter((c) => c.status === "error").length} 失败` +
            `${rc.durationMs !== undefined ? `，${(rc.durationMs / 1000).toFixed(0)}s` : ""}）`
          : ""

        if (ai.planner && ai.planner.proposals.length > 0) {
          // 覆盖报告与 dashboard（同一份 HTML 更新为「含 AI」版本，不新建 -02）
          const aiWritten = writeReports(cwd, ref, ai, {
            aiEnabled: true,
            ...(ai.planner.analysisSummary ? { aiSummary: ai.planner.analysisSummary } : {}),
            ...(dashboardPath ? { overwriteDashboard: dashboardPath } : {}),
          })
          reportPath = aiWritten.mdPath ?? reportPath
          dashboardPath = aiWritten.dashboardPath ?? dashboardPath
          const lines = [...(ruleCheckSummary ? [ruleCheckSummary, ""] : []), `AI 优化建议 ${ai.planner.proposals.length} 条：`]
          for (const p of ai.planner.proposals.slice(0, 5)) {
            lines.push(`- [${p.severity}] ${p.title}`)
            lines.push(`  ${p.proposal.action.slice(0, 120)}`)
            lines.push(`  验证：${p.validation.join("；").slice(0, 120)}`)
          }
          if (ai.planner.proposals.length > 5) lines.push(`…另有 ${ai.planner.proposals.length - 5} 条，见报告文件`)
          lines.push(`\n完整报告：${reportPath ?? "(落盘失败)"}`)
          if (dashboardPath) lines.push(`Dashboard：${dashboardPath}`)
          ctx.ui.notify(lines.join("\n"), "info")
        } else {
          // 没有 Planner 建议但可能有 AI 规则检查结果：仍需落盘（否则 Dashboard 看不到 rule check）
          if (rc) {
            const written2 = writeReports(cwd, ref, ai, {
              aiEnabled: true,
              ...(dashboardPath ? { overwriteDashboard: dashboardPath } : {}),
            })
            reportPath = written2.mdPath ?? reportPath
            dashboardPath = written2.dashboardPath ?? dashboardPath
          }
          const diag = ai.report?.diagnostics.find((d) => /AI 建议/.test(d))
          ctx.ui.notify(
            [
              ...(ruleCheckSummary ? [ruleCheckSummary] : []),
              `AI 建议未生成${diag ? `：${diag}` : "（模型未给出可校验的结构化建议）"}；静态分析结果已在上方。`,
              ...(dashboardPath ? [`Dashboard：${dashboardPath}`] : []),
            ].join("\n"),
            "warning",
          )
        }
      } catch (e) {
        ctx.ui.notify(`AI 建议失败（静态结果已给出）：${String((e as Error)?.message ?? e).slice(0, 200)}`, "warning")
      }
    }

    // Dashboard 在静态阶段就已生成：无论 AI 成败都要能让用户打开
    // 路径已在摘要里；这里只在真的尝试打开时补充动作结果（避免多一条通知把结论挤掉）
    if (dashboardPath && !flags.has("--no-open") && shouldAutoOpen().open) {
      const r = await openInBrowser(dashboardPath)
      if (!r.ok) {
        ctx.ui.notify(`Dashboard 已生成但打开失败（${r.error?.slice(0, 80)}）：${dashboardPath}`, "warning")
      }
    }
    void deps
  }
}

/** /workflows plan validate <plan.json>：Plan 校验（Schema/Profile 边界/指纹/过期） */
export const planSubcommand: Subcommand = {
  usage: "plan validate <plan.json>         校验 Plan（Profile 边界/指纹/过期）",
  async run(argv, ctx, deps) {
    try {
      await runPlanValidate(argv, ctx, deps)
    } catch (e) {
      ctx.ui.notify(`Plan 校验失败：${String((e as Error)?.stack ?? e).slice(0, 600)}`, "warning")
    }
  },
}

async function runPlanValidate(argv: string[], ctx: any, deps: any): Promise<void> {
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
}

/** 报告落盘：Markdown + JSON（两段式共用） */
interface WriteReportsResult {
  mdPath?: string
  dashboardPath?: string
}

/**
 * 落盘报告：.md / .json / dashboard/*.html
 * dashboard 失败不影响 md/json（报告主体优先）；AI 阶段用 overwriteDashboard 覆盖同一份 HTML，
 * 避免同一次分析产生 -01/-02 两份（递增命名只用于多次运行之间）。
 */
function writeReports(
  cwd: string,
  ref: string,
  result: { rendered?: string; report?: unknown },
  opts: { aiEnabled?: boolean; aiSummary?: string; overwriteDashboard?: string } = {},
): WriteReportsResult {
  const out: WriteReportsResult = {}
  try {
    const dir = path.join(cwd, REPORT_DIR)
    fs.mkdirSync(dir, { recursive: true })
    const base = path.basename(ref.replace(/[/]$/, ""), path.extname(ref)) || path.basename(ref)
    const mdPath = path.join(dir, `${base}.analysis.md`)
    fs.writeFileSync(mdPath, result.rendered ?? "", "utf8")
    fs.writeFileSync(path.join(dir, `${base}.analysis.json`), JSON.stringify(result.report ?? {}, null, 2), "utf8")
    // 返回绝对路径：相对路径在终端里既不能点也不好定位
    out.mdPath = mdPath

    if (result.report) {
      const dw = writeDashboard({
        report: result.report as Parameters<typeof writeDashboard>[0]["report"],
        outDir: dir,
        projectName: base,
        ...(opts.aiEnabled !== undefined ? { aiEnabled: opts.aiEnabled } : {}),
        ...(opts.aiSummary ? { aiSummary: opts.aiSummary } : {}),
        ...(opts.overwriteDashboard ? { overwritePath: opts.overwriteDashboard } : {}),
      })
      out.dashboardPath = dw.htmlPath
    }
  } catch (e) {
    // dashboard 生成失败不阻断报告落盘，但要留下痕迹（不能静默）
    console.warn(`[pi-code-mode] Dashboard 生成失败：${String((e as Error)?.message ?? e)}`)
  }
  return out
}
