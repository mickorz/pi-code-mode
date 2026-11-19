/**
 * Analysis Dashboard 生成（零依赖单文件 HTML）
 *
 * 设计参考 thirdparties/PrdGameSkill/.claude/skills/game-prd-check 的 dashboard 管线，
 * 但**省掉 Markdown 反解析**这一层：AnalysisReport 本身就是结构化数据，直接投影成视图模型，
 * 天然与 Markdown 报告一致（不会出现"报告说 3 条、页面说 5 条"）。
 *
 * 关键约束：
 *  - 数据内嵌 `<script type="application/json">`，不 fetch —— file:// 双击可直接打开
 *  - 不内嵌各子文件完整 report（12 文件会到 MB 级），只放渲染必需字段
 *  - 生成前校验，失败抛错不产出残缺 HTML（避免"打开是空白页"）
 *  - 文件名 `{项目名}分析-Dashboard-{YYYYMMDD}-{NN}.html` 同日递增不覆盖
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { AnalysisReport } from "../report-builder.js"

/** Dashboard 视图模型：模板 __REPORT_JSON__ 的唯一内容 */
export interface DashboardView {
  meta: {
    file: string
    generatedAt: string
    riskScore: number
    analyzerVersion: string
    ruleSetVersion: string
    sourceHash: string
    /** 本次是否跑了 AI 复核（决定页面是否显示 AI 段） */
    aiEnabled: boolean
    /** AI 的一句话总结（AI 未跑时缺省） */
    aiSummary?: string
  }
  estimate: {
    callSites: number
    agentCallSites: number
    workflowCallSites: number
    estimatedTasks: number
    determined: boolean
    dynamicNodes: number
    concurrency?: number
    estimatedWaves?: number
  }
  summary: { totalFindings: number; counts: Record<string, number> }
  /** 全量规则检查清单（含未命中的）——用户核心诉求：能看出"检查了什么" */
  rules: Array<{ id: string; severity: string; description: string; hits: number; status: "hit" | "pass" | "error"; error?: string }>
  findings: Array<{
    severity: string
    ruleId: string
    confidence: number
    file?: string
    startLine: number
    endLine: number
    evidence: string[]
    snippet?: string
    suggestion?: string
  }>
  recommendations: Array<{
    id: string
    title: string
    ruleIds: string[]
    severity: string
    expectedImpact: string
    qualityRisk: string
    validation: string[]
    /** "ai" = 模型复核产出；缺省 = 静态规则产出 */
    source?: string
  }>
  subtree?: {
    files: number
    callSites: number
    maxRisk: number
    riskiest?: string
    totalFindings: number
    rules: Record<string, number>
    subWorkflows: Array<{ file: string; riskScore: number; callSites: number; totalFindings: number; topRule?: string }>
  }
  unknowns: Array<{ line: number; id: string; reason: string }>
  diagnostics: string[]
}

/** 把 AnalysisReport 投影成视图模型（纯函数，可单测） */
export function buildDashboardView(
  report: AnalysisReport,
  opts: { aiEnabled?: boolean; aiSummary?: string; generatedAt?: string } = {},
): DashboardView {
  const view: DashboardView = {
    meta: {
      file: report.file ?? "(inline)",
      generatedAt: opts.generatedAt ?? new Date().toISOString(),
      riskScore: report.summary.riskScore,
      analyzerVersion: report.analyzerVersion,
      ruleSetVersion: report.ruleSetVersion,
      sourceHash: report.sourceHash,
      aiEnabled: opts.aiEnabled === true,
      ...(opts.aiSummary ? { aiSummary: opts.aiSummary } : {}),
    },
    estimate: {
      callSites: report.executionEstimate.callSites,
      agentCallSites: report.executionEstimate.agentCallSites,
      workflowCallSites: report.executionEstimate.workflowCallSites,
      estimatedTasks: report.executionEstimate.estimatedTasks,
      determined: report.executionEstimate.determined,
      dynamicNodes: report.executionEstimate.dynamicNodes,
      ...(report.executionEstimate.concurrency !== undefined ? { concurrency: report.executionEstimate.concurrency } : {}),
      ...(report.executionEstimate.estimatedWaves !== undefined
        ? { estimatedWaves: report.executionEstimate.estimatedWaves }
        : {}),
    },
    summary: { totalFindings: report.summary.totalFindings, counts: report.summary.counts as Record<string, number> },
    rules: report.ruleInventory.map((r) => ({
      id: r.id,
      severity: r.severity,
      description: r.description,
      hits: r.hits,
      status: r.status,
      ...(r.error ? { error: r.error } : {}),
    })),
    findings: report.findings.map((f) => ({
      severity: f.severity,
      ruleId: f.ruleId,
      confidence: f.confidence,
      ...(f.location.file ? { file: f.location.file } : {}),
      startLine: f.location.startLine,
      endLine: f.location.endLine,
      evidence: f.evidence,
      ...(f.snippet ? { snippet: f.snippet } : {}),
      ...(f.suggestion ? { suggestion: f.suggestion } : {}),
    })),
    recommendations: report.recommendations.map((r) => ({
      id: r.id,
      title: r.title,
      ruleIds: r.ruleIds,
      severity: r.severity,
      expectedImpact: r.expectedImpact,
      qualityRisk: r.qualityRisk,
      validation: r.validation,
      ...(r.source ? { source: r.source } : {}),
    })),
    unknowns: report.dependencies.unknowns.map((u) => ({ line: u.line, id: u.id, reason: u.reason })),
    diagnostics: report.diagnostics,
  }
  if (report.subtree && report.subtree.files > 1) {
    view.subtree = {
      files: report.subtree.files,
      callSites: report.subtree.callSites,
      maxRisk: report.subtree.maxRisk,
      ...(report.subtree.riskiest ? { riskiest: report.subtree.riskiest } : {}),
      totalFindings: report.subtree.totalFindings,
      rules: report.subtree.rules,
      subWorkflows: report.subtree.subWorkflows.map((s) => ({
        file: s.file,
        riskScore: s.riskScore,
        callSites: s.callSites,
        totalFindings: s.totalFindings,
        ...(s.topRule ? { topRule: s.topRule } : {}),
      })),
    }
    // 子流程 finding 并入问题列表：入口报告自身 findings 往往很少（脏活在子文件），
    // 不并入会让「问题列表」只剩 1 条、规则清单看着「全部通过」——与聚合事实矛盾。
    for (const sw of report.subtree.subWorkflows) {
      for (const f of sw.findings) {
        view.findings.push({
          severity: f.severity,
          ruleId: f.ruleId,
          confidence: f.confidence,
          file: sw.file,
          startLine: f.startLine,
          endLine: f.endLine,
          evidence: f.evidence,
          ...(f.snippet ? { snippet: f.snippet } : {}),
          ...(f.suggestion ? { suggestion: f.suggestion } : {}),
        })
      }
    }
    // 规则命中数合并子流程：否则规则页显示 CONC-002「通过」，而子文件实际命中
    for (const r of view.rules) {
      const subHits = report.subtree.rules[r.id] ?? 0
      if (subHits > 0) {
        r.hits += subHits
        r.status = "hit"
      }
    }
    // 必须重算：summary.counts 原本只统计入口自己的 findings，
    // 合并子流程后不重算会得到「23 条问题但严重度分布只有 1 条」的矛盾
    const counts: Record<string, number> = {}
    for (const f of view.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1
    view.summary.counts = counts
    view.summary.totalFindings = view.findings.length
  }
  return view
}

/** 生成前校验：缺关键字段就抛错，绝不产出空白页 */
export function validateView(view: DashboardView): string[] {
  const errors: string[] = []
  if (!view.meta || typeof view.meta.file !== "string") errors.push("meta.file 缺失")
  if (!Array.isArray(view.rules) || view.rules.length === 0) errors.push("rules 为空：无法展示检查清单")
  for (const [i, r] of (view.rules ?? []).entries()) {
    if (!r.id) errors.push(`rules[${i}].id 缺失`)
    if (!r.description) errors.push(`rules[${i}].description 缺失`)
    if (!["hit", "pass", "error"].includes(r.status)) errors.push(`rules[${i}].status 非法：${r.status}`)
  }
  for (const [i, f] of (view.findings ?? []).entries()) {
    if (!f.ruleId) errors.push(`findings[${i}].ruleId 缺失`)
    if (!Number.isFinite(f.startLine)) errors.push(`findings[${i}].startLine 非法`)
  }
  if (view.summary.totalFindings !== (view.findings ?? []).length) {
    errors.push(`summary.totalFindings(${view.summary.totalFindings}) 与 findings 数(${view.findings?.length}) 不一致`)
  }
  return errors
}

/** 同日递增命名：{项目}分析-Dashboard-{YYYYMMDD}-{NN}.html，不覆盖历史 */
export function nextDashboardName(dir: string, projectName: string, now = new Date()): string {
  const safe = String(projectName || "workflow").replace(/[\\/:*?"<>|]/g, "").trim() || "workflow"
  const pad = (n: number) => String(n).padStart(2, "0")
  const ymd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const prefix = `${safe}分析-Dashboard-${ymd}-`
  const prefixRe = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d{2})\\.html$`)
  let seq = 1
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(prefixRe)
      if (m) seq = Math.max(seq, Number(m[1]) + 1)
    }
  }
  return `${prefix}${pad(seq)}.html`
}

/** 模板与编译产物同目录（dev 走 src、发布走 dist，结构一致） */
function templatePath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "template.html")
}

/** 把视图模型注入模板（JSON 内联，转义 `</script>` 防提前闭合） */
export function renderDashboardHtml(view: DashboardView, template?: string): string {
  const tpl = template ?? fs.readFileSync(templatePath(), "utf8")
  const json = JSON.stringify(view).replace(/<\/script/gi, "<\\/script")
  return tpl.replace("__REPORT_JSON__", json)
}

export interface WriteDashboardResult {
  htmlPath: string
  jsonPath: string
  view: DashboardView
}

/**
 * 生成并落盘 dashboard。
 * outDir 通常与 .md/.json 报告同目录，HTML 放其下 dashboard/ 子目录。
 */
export function writeDashboard(opts: {
  report: AnalysisReport
  outDir: string
  projectName: string
  aiEnabled?: boolean
  aiSummary?: string
  /** 覆盖指定 HTML（同一次分析的静态阶段→AI 阶段更新）；缺省按同日递增新建 */
  overwritePath?: string
}): WriteDashboardResult {
  const view = buildDashboardView(opts.report, {
    ...(opts.aiEnabled !== undefined ? { aiEnabled: opts.aiEnabled } : {}),
    ...(opts.aiSummary ? { aiSummary: opts.aiSummary } : {}),
  })
  const errors = validateView(view)
  if (errors.length > 0) {
    throw new Error(`Dashboard 校验未通过（不产出残缺页面）：${errors.join("; ")}`)
  }
  const dashDir = path.join(opts.outDir, "dashboard")
  fs.mkdirSync(dashDir, { recursive: true })
  const htmlPath = opts.overwritePath ?? path.join(dashDir, nextDashboardName(dashDir, opts.projectName))
  fs.writeFileSync(htmlPath, renderDashboardHtml(view), "utf8")
  const jsonPath = path.join(dashDir, `${path.basename(htmlPath, ".html")}.json`)
  fs.writeFileSync(jsonPath, JSON.stringify(view, null, 2), "utf8")
  return { htmlPath, jsonPath, view }
}
