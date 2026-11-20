/**
 * 优化闭环工作流（M5-T5）
 *
 * 固定六步链（架构基线陷阱 3 + 执行计划 T7）：
 *   ① Analyzer 分析
 *   ② 生成 Optimization Suggestions
 *   ③ 在**独立工作区**修改（绝不直接改生产脚本）
 *   ④ 重新 Analyzer + Benchmark
 *   ⑤ 用户确认（授权闸门）
 *   ⑥ 应用修改 / 放弃
 *
 * 本模块只实现「编排与闸门」，不执行模型调用与文件修改：
 *  - analyze / propose / apply 由调用方注入（便于测试与复用）
 *  - 每一步失败即中止，工作区清理
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { AnalysisReport, Recommendation } from "../analyzer/report-builder.js"

export type LoopStage = "analyze" | "suggest" | "workspace-edit" | "reanalyze" | "confirm" | "apply"

export interface LoopStepResult {
  stage: LoopStage
  ok: boolean
  detail: string
}

export interface OptimizationLoopOptions {
  /** 生产脚本路径（只读；应用阶段才写入） */
  scriptPath: string
  cwd?: string
  /** ① 分析器（注入） */
  analyze: (scriptPath: string) => Promise<AnalysisReport>
  /** ② 建议生成器（注入；返回建议 + 修改后的脚本内容） */
  propose: (input: { report: AnalysisReport; source: string }) => Promise<{ recommendations: Recommendation[]; patchedSource?: string }>
  /** ④ 基准执行器（注入；返回耗时/质量指标） */
  benchmark?: (input: { scriptPath: string; label: "before" | "after" }) => Promise<{ durationMs?: number; inputTokens?: number; qualityOk?: boolean }>
  /** ⑤ 授权闸门（缺省拒绝：headless 不允许自动应用） */
  confirm?: (input: { recommendations: Recommendation[]; beforeMarkdown: string; afterMarkdown: string }) => Promise<boolean>
  /** 显式允许无闸门应用（仅供测试；生产禁止） */
  dangerouslyAutoApprove?: boolean
}

export interface OptimizationLoopResult {
  ok: boolean
  /** 最终是否应用到生产脚本 */
  applied: boolean
  steps: LoopStepResult[]
  workspaceDir?: string
  beforeRiskScore?: number
  afterRiskScore?: number
  recommendations: Recommendation[]
  /** 中止原因 */
  abortedAt?: LoopStage
  reason?: string
}

/**
 * 执行闭环。默认在「确认」阶段拒绝（headless 安全默认）。
 */
export async function runOptimizationLoop(opts: OptimizationLoopOptions): Promise<OptimizationLoopResult> {
  const cwd = opts.cwd ?? process.cwd()
  const productionPath = path.resolve(cwd, opts.scriptPath)
  const steps: LoopStepResult[] = []
  const recommendations: Recommendation[] = []

  if (!fs.existsSync(productionPath)) {
    return { ok: false, applied: false, steps, recommendations, reason: `生产脚本不存在：${opts.scriptPath}` }
  }
  const source = fs.readFileSync(productionPath, "utf8")

  // ① 分析
  const before = await opts.analyze(productionPath)
  steps.push({ stage: "analyze", ok: true, detail: `风险分 ${before.summary.riskScore}，finding ${before.summary.totalFindings}` })

  // ② 建议
  const proposal = await opts.propose({ report: before, source })
  recommendations.push(...proposal.recommendations)
  steps.push({ stage: "suggest", ok: true, detail: `生成 ${proposal.recommendations.length} 条建议` })
  if (!proposal.patchedSource) {
    steps.push({ stage: "workspace-edit", ok: false, detail: "未提供 patchedSource（无可应用修改）" })
    return { ok: false, applied: false, steps, recommendations, beforeRiskScore: before.summary.riskScore, abortedAt: "workspace-edit", reason: "无可应用修改" }
  }

  // ③ 独立工作区修改（生产脚本绝不在此阶段被写入）
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "m5-loop-"))
  const workspaceScript = path.join(workspaceDir, path.basename(opts.scriptPath))
  fs.writeFileSync(workspaceScript, proposal.patchedSource, "utf8")
  const productionUnchanged = fs.readFileSync(productionPath, "utf8") === source
  steps.push({
    stage: "workspace-edit",
    ok: productionUnchanged,
    detail: productionUnchanged
      ? `在工作区修改：${workspaceScript}（生产脚本未改动）`
      : "生产脚本被意外修改（违反独立工作区约束）",
  })
  if (!productionUnchanged) {
    return { ok: false, applied: false, steps, recommendations, workspaceDir, beforeRiskScore: before.summary.riskScore, abortedAt: "workspace-edit", reason: "生产脚本被改动" }
  }

  // ④ 重新分析（工作区）+ 可选 Benchmark
  const after = await opts.analyze(workspaceScript)
  const improved = after.summary.riskScore <= before.summary.riskScore
  steps.push({
    stage: "reanalyze",
    ok: improved,
    detail: `风险分 ${before.summary.riskScore} → ${after.summary.riskScore}${improved ? "" : "（未改善，需人工复核）"}`,
  })
  if (!improved) {
    return {
      ok: false,
      applied: false,
      steps,
      recommendations,
      workspaceDir,
      beforeRiskScore: before.summary.riskScore,
      afterRiskScore: after.summary.riskScore,
      abortedAt: "reanalyze",
      reason: `重新分析未改善（风险分 ${before.summary.riskScore} → ${after.summary.riskScore}），需人工复核`,
    }
  }
  if (opts.benchmark) {
    const b = await opts.benchmark({ scriptPath: productionPath, label: "before" })
    const a = await opts.benchmark({ scriptPath: workspaceScript, label: "after" })
    const qualityOk = (a.qualityOk ?? true) && (b.qualityOk ?? true)
    steps.push({
      stage: "reanalyze",
      ok: qualityOk,
      detail: `Benchmark：耗时 ${b.durationMs ?? "?"} → ${a.durationMs ?? "?"}，质量 ${qualityOk ? "未降级" : "降级"}`,
    })
    if (!qualityOk) {
      return { ok: false, applied: false, steps, recommendations, workspaceDir, beforeRiskScore: before.summary.riskScore, afterRiskScore: after.summary.riskScore, abortedAt: "reanalyze", reason: "质量降级，拒绝应用" }
    }
  }

  // ⑤ 授权闸门（默认拒绝）
  const approved = opts.dangerouslyAutoApprove === true ? true : opts.confirm ? await opts.confirm({ recommendations, beforeMarkdown: "", afterMarkdown: "" }) : false
  steps.push({
    stage: "confirm",
    ok: approved,
    detail: approved ? "已授权应用" : "未授权（headless 默认拒绝；需用户确认）",
  })
  if (!approved) {
    return {
      ok: false,
      applied: false,
      steps,
      recommendations,
      workspaceDir,
      beforeRiskScore: before.summary.riskScore,
      afterRiskScore: after.summary.riskScore,
      abortedAt: "confirm",
      reason: "未获授权，修改保留在工作区（生产脚本未改）",
    }
  }

  // ⑥ 应用（原子写）
  const tmpFile = `${productionPath}.loop-tmp`
  fs.writeFileSync(tmpFile, proposal.patchedSource, "utf8")
  fs.renameSync(tmpFile, productionPath)
  steps.push({ stage: "apply", ok: true, detail: `已应用到 ${opts.scriptPath}` })

  return {
    ok: true,
    applied: true,
    steps,
    workspaceDir,
    beforeRiskScore: before.summary.riskScore,
    afterRiskScore: after.summary.riskScore,
    recommendations,
  }
}

/** 渲染闭环报告 */
export function renderLoopResult(r: OptimizationLoopResult): string {
  const lines = [`# 优化闭环：${r.ok ? (r.applied ? "已应用" : "未应用") : "中止"}`, ""]
  for (const s of r.steps) lines.push(`- [${s.ok ? "✓" : "✗"}] **${s.stage}**：${s.detail}`)
  if (r.abortedAt) lines.push("", `中止于 \`${r.abortedAt}\`：${r.reason}`)
  if (r.beforeRiskScore !== undefined && r.afterRiskScore !== undefined) {
    lines.push("", `风险分：${r.beforeRiskScore} → ${r.afterRiskScore}`)
  }
  if (r.workspaceDir && !r.applied) lines.push("", `工作区保留（可人工复核）：${r.workspaceDir}`)
  return lines.join("\n")
}
