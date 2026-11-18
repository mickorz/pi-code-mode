/**
 * AI Optimization Planner（M1-T5）
 *
 * 职责边界（架构基线 3.3）：
 *  - 不重读整个项目；只消费 Static Analyzer 的结构化报告 + 必要局部代码片段
 *  - 输出结构化建议（target/proposal/expectedImpact/qualityRisk/validation），不接受泛泛「建议并行化」
 *  - 收益无基准时必须是「待 Benchmark」（陷阱：不虚构数值）
 *  - 不直接改代码：建议经授权链才可应用（执行计划 T7 六步链）
 *
 * 设计：核心是纯函数 buildPlannerPrompt / validatePlannerOutput，
 * 模型调用由调用方注入（analyzerPlannerAgent），便于无模型测试。
 */
import type { AnalysisReport, Recommendation } from "./report-builder.js"
import type { Severity } from "./types.js"

export interface OptimizationProposal {
  /** 建议 id（OPT-xxx，与静态建议可对应） */
  id: string
  title: string
  severity: Severity
  /** 修改目标（文件 + 行区间） */
  target: { file?: string; startLine: number; endLine: number }
  /** 问题描述 */
  problem: string
  /** 具体改法（必须可执行） */
  proposal: { type: string; action: string; codeSketch?: string }
  /** 依赖关系说明（为什么可以/不可以这样改） */
  dependencyAnalysis: string
  /** 预期收益：无基准时写「待 Benchmark」 */
  expectedImpact: { duration?: string; inputTokens?: string; note: string }
  qualityRisk: "low" | "medium" | "high"
  /** 质量风险说明（尤其 Evidence Reference / 覆盖率风险） */
  qualityRiskNote?: string
  /** 验证条件（必须非空） */
  validation: string[]
}

export interface PlannerOutput {
  analysisSummary: string
  proposals: OptimizationProposal[]
}

/** 构造精简 Prompt：只给报告摘要 + 局部代码（不塞整文件） */
export function buildPlannerPrompt(report: AnalysisReport, opts: { codeSnippet?: string; maxFindings?: number } = {}): string {
  const maxFindings = opts.maxFindings ?? 12
  const top = report.findings.slice(0, maxFindings)
  const lines: string[] = []
  lines.push("你是 Workflow 性能优化顾问。基于以下**静态分析报告**提出结构化优化方案。")
  lines.push("")
  lines.push("硬性要求：")
  lines.push("1. 不要重新分析整个项目，只用给定信息；信息不足时明确说「信息不足」而不是猜测。")
  lines.push("2. 只对 confidence ≥ 0.5 的 finding 提建议；Candidate/Unknown 必须标注「需语义确认」。")
  lines.push("3. 每条建议必须说明：依赖关系（为什么能改）、修改方式（可执行）、验证条件。")
  lines.push("4. **不得虚构数值收益**：没有基准数据时写「待 Benchmark」。")
  lines.push("5. 涉及共享上下文压缩的建议，必须保留原始证据可按需读取（Evidence Reference 层）。")
  lines.push("6. 不要建议直接修改生产脚本；输出建议即可，应用需走授权链。")
  lines.push("")
  lines.push("## 分析报告摘要")
  lines.push(`- 文件: ${report.file ?? "(inline)"}`)
  lines.push(`- 风险分: ${report.summary.riskScore}/100`)
  lines.push(`- 调用点: ${report.executionEstimate.callSites}（agent ${report.executionEstimate.agentCallSites}）`)
  lines.push(`- 估算任务量: ${report.executionEstimate.estimatedTasks}${report.executionEstimate.determined ? "" : "（含动态，下限）"}`)
  if (report.executionEstimate.concurrency !== undefined) lines.push(`- 并发上限: ${report.executionEstimate.concurrency}`)
  if (report.executionEstimate.estimatedWaves !== undefined) lines.push(`- 预计波次: ${report.executionEstimate.estimatedWaves}`)
  lines.push("")
  lines.push("## Findings")
  for (const f of top) {
    lines.push(`- [${f.severity}/${f.confidence.toFixed(2)}] ${f.ruleId} L${f.location.startLine}-${f.location.endLine}`)
    for (const ev of f.evidence) lines.push(`  - ${ev}`)
  }
  if (report.dependencies.unknowns.length > 0) {
    lines.push("")
    lines.push("## 静态不可判定（不可据此自动并行化）")
    for (const u of report.dependencies.unknowns) lines.push(`- L${u.line}: ${u.reason}`)
  }
  if (opts.codeSnippet) {
    lines.push("")
    lines.push("## 相关代码片段")
    lines.push("```js")
    lines.push(opts.codeSnippet.slice(0, 4000))
    lines.push("```")
  }
  lines.push("")
  lines.push("输出 JSON：{ analysisSummary: string, proposals: [{ id, title, severity, target:{startLine,endLine}, problem, proposal:{type,action,codeSketch?}, dependencyAnalysis, expectedImpact:{note}, qualityRisk, validation: string[] }] }")
  return lines.join("\n")
}

/**
 * 校验模型输出（拒绝泛泛建议）：
 *  - proposals 必须为数组
 *  - 每条必须有 dependencyAnalysis / validation≥1 / expectedImpact.note
 *  - 若 note 含具体百分比而报告无基准 → 降级为「待 Benchmark」
 */
export function validatePlannerOutput(raw: unknown): { ok: boolean; errors: string[]; output?: PlannerOutput } {
  const errors: string[] = []
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["输出必须是对象"] }
  const obj = raw as Record<string, any>
  if (typeof obj.analysisSummary !== "string") errors.push("analysisSummary 必须是字符串")
  if (!Array.isArray(obj.proposals)) errors.push("proposals 必须是数组")

  const proposals: OptimizationProposal[] = []
  for (const [i, p] of (Array.isArray(obj.proposals) ? obj.proposals : []).entries()) {
    if (!p || typeof p !== "object") {
      errors.push(`proposals[${i}] 必须是对象`)
      continue
    }
    const path = `proposals[${i}]`
    if (typeof p.title !== "string" || !p.title.trim()) errors.push(`${path}.title 不能为空`)
    if (typeof p.dependencyAnalysis !== "string" || p.dependencyAnalysis.trim().length < 10) {
      errors.push(`${path}.dependencyAnalysis 必须说明依赖关系（≥10 字）`)
    }
    if (!Array.isArray(p.validation) || p.validation.length === 0) {
      errors.push(`${path}.validation 至少一条验证条件`)
    }
    if (!p.expectedImpact || typeof p.expectedImpact.note !== "string") {
      errors.push(`${path}.expectedImpact.note 必须说明收益依据`)
    } else if (!/待\s*Benchmark|无法估算|无基准/i.test(p.expectedImpact.note) && /\d+\s*%/.test(p.expectedImpact.note)) {
      // 无基准却给百分比 → 改写为待 Benchmark
      p.expectedImpact.note = "待 Benchmark 验证（静态分析不提供数值收益）"
    }
    if (!["low", "medium", "high"].includes(String(p.qualityRisk))) p.qualityRisk = "medium"
    if (!p.proposal || typeof p.proposal.action !== "string" || !p.proposal.action.trim()) {
      errors.push(`${path}.proposal.action 必须给出可执行改法`)
    }
    const startLine = Number(p.target?.startLine ?? 1)
    const endLine = Number(p.target?.endLine ?? startLine)
    proposals.push({
      id: typeof p.id === "string" && p.id ? p.id : `OPT-${String(i + 1).padStart(3, "0")}`,
      title: String(p.title ?? "").slice(0, 80),
      severity: (["critical", "high", "medium", "low"].includes(String(p.severity)) ? p.severity : "medium") as Severity,
      target: { ...(p.target?.file ? { file: String(p.target.file) } : {}), startLine, endLine },
      problem: String(p.problem ?? ""),
      proposal: {
        type: String(p.proposal?.type ?? "refactor"),
        action: String(p.proposal?.action ?? ""),
        ...(p.proposal?.codeSketch ? { codeSketch: String(p.proposal.codeSketch).slice(0, 2000) } : {}),
      },
      dependencyAnalysis: String(p.dependencyAnalysis ?? ""),
      expectedImpact: {
        ...(typeof p.expectedImpact?.duration === "string" ? { duration: p.expectedImpact.duration } : {}),
        ...(typeof p.expectedImpact?.inputTokens === "string" ? { inputTokens: p.expectedImpact.inputTokens } : {}),
        note: String(p.expectedImpact?.note ?? "待 Benchmark 验证"),
      },
      qualityRisk: p.qualityRisk as "low" | "medium" | "high",
      ...(typeof p.qualityRiskNote === "string" ? { qualityRiskNote: p.qualityRiskNote } : {}),
      validation: (Array.isArray(p.validation) ? p.validation : []).map((v: unknown) => String(v)),
    })
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, errors: [], output: { analysisSummary: obj.analysisSummary, proposals } }
}

/** 从模型原始文本中提取 JSON 块并校验（容忍 ```json 围栏与前后解释文字） */
export function parsePlannerResponse(text: string): { ok: boolean; errors: string[]; output?: PlannerOutput } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced ? fenced[1]! : text
  const first = candidate.indexOf("{")
  const last = candidate.lastIndexOf("}")
  if (first === -1 || last <= first) return { ok: false, errors: ["响应中未找到 JSON 对象"] }
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate.slice(first, last + 1))
  } catch (e) {
    return { ok: false, errors: [`JSON 解析失败：${String((e as Error)?.message ?? e)}`] }
  }
  return validatePlannerOutput(parsed)
}

/** 把静态建议与 AI 建议合并（静态建议始终保留，AI 建议去重叠加） */
export function mergeRecommendations(staticRecs: Recommendation[], ai: PlannerOutput | undefined): Recommendation[] {
  const out = [...staticRecs]
  if (!ai) return out
  for (const p of ai.proposals) {
    const dup = out.find((r) => r.title === p.title || r.ruleIds.some((id) => p.problem.includes(id)))
    if (dup) continue
    out.push({
      id: p.id,
      title: p.title,
      ruleIds: [],
      severity: p.severity,
      expectedImpact: p.expectedImpact.note,
      qualityRisk: p.qualityRisk,
      validation: p.validation,
    })
  }
  return out
}
