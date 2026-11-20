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

/**
 * 构造精简 Prompt
 *
 * 2026-11-19 实测（glm-5.3-flash，当前唯一可用 provider，reasoning 模型）：
 *  - 原版 5126 字符（含 4000 字符源码片段 + TS schema 描述）→ 120~260s 零响应，60s/180s 全超时
 *  - 瘦身版 784 字符（无源码 + findings 一行一条 + JSON 示例）→ 63~71s 正常返回
 *
 * 结论：① 不塞源码——模型只看结构摘要就能给建议；② 输出格式用「照抄示例」而不是
 * 「schema 描述」（`{ analysisSummary: string, ... }` 这种形态会让该模型长时间无任何输出）。
 * 参数只有 maxFindings/maxProposals：体积与条数直接决定成败，其余调参无实测依据。
 */
export function buildPlannerPrompt(report: AnalysisReport, opts: { maxFindings?: number; maxProposals?: number } = {}): string {
  const maxFindings = opts.maxFindings ?? 12
  const maxProposals = opts.maxProposals ?? 3
  const top = report.findings.slice(0, maxFindings)
  const e = report.executionEstimate
  const lines: string[] = []
  lines.push("你是 Workflow 性能优化顾问。仅基于下面的静态分析摘要提建议，不要重新分析项目，信息不足就说信息不足。")
  lines.push("")
  lines.push("## 分析报告摘要")
  lines.push(
    `- 文件: ${report.file ?? "(inline)"} | 风险分 ${report.summary.riskScore}/100 | 调用点 ${e.callSites}（agent ${e.agentCallSites}）| 估算任务量 ${e.estimatedTasks}${e.determined ? "" : "（含动态，下限）"}`,
  )
  if (e.concurrency !== undefined) {
    lines.push(`- 并发上限 ${e.concurrency}${e.estimatedWaves !== undefined ? ` | 预计波次 ${e.estimatedWaves}` : ""}`)
  }
  lines.push("")
  lines.push("## Findings")
  // 一行一条：证据合并到同一行，避免嵌套列表把 prompt 撑大
  if (top.length === 0) lines.push("（无）")
  for (const [i, f] of top.entries()) {
    lines.push(
      `${i + 1}. ${f.ruleId} (${f.severity}, 置信度${f.confidence.toFixed(2)}) L${f.location.startLine}-${f.location.endLine}: ${f.evidence.join("；")}`,
    )
  }
  if (report.dependencies.unknowns.length > 0) {
    lines.push("")
    lines.push("## 静态不可判定（禁止据此自动并行化）")
    lines.push(report.dependencies.unknowns.map((u) => `L${u.line}: ${u.reason}`).join("；"))
  }
  lines.push("")
  lines.push("## 要求")
  lines.push(`- 最多 ${maxProposals} 条建议，只针对上面列出的问题`)
  lines.push("- 每条必须说明：能否改（依赖关系）、怎么改（可执行动作）、怎么验证")
  lines.push("- 只对置信度 ≥ 0.5 的问题给确定建议；置信度 < 0.5 的必须标注「需语义确认」")
  lines.push("- 不得虚构数值收益，没有基准数据就写「待 Benchmark」")
  lines.push("- 涉及共享上下文压缩时，必须保留原始证据可按需读取（Evidence Reference 层）")
  lines.push("- 不要建议直接修改生产脚本：输出建议即可，应用需走授权链")
  lines.push("- 只输出 JSON，不要 markdown 围栏，不要解释文字")
  lines.push("")
  lines.push("## 输出格式（照抄这个结构）")
  lines.push(
    '{"analysisSummary":"一句话","proposals":[{"id":"OPT-001","title":"标题","severity":"medium","target":{"startLine":1,"endLine":2},"problem":"问题","proposal":{"type":"parallel","action":"动作"},"dependencyAnalysis":"依赖","expectedImpact":{"note":"待 Benchmark"},"qualityRisk":"low","validation":["验收1"]}]}',
  )
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
    const toRec = (ruleIds: string[], id: string): Recommendation => ({
      id,
      title: p.title,
      ruleIds,
      severity: p.severity,
      expectedImpact: p.expectedImpact.note,
      qualityRisk: p.qualityRisk,
      validation: p.validation,
      source: "ai" as const,
    })
    // 同源（静态建议的 ruleId 出现在 AI 的问题描述里）→ 用 AI 版本**替换**而不是丢弃。
    // 2026-11-19 修复：旧实现 `if (dup) continue` 把 AI 精心写的行动方案/依赖分析整条扔掉，
    // 用户看到的仍是一行静态模板文案——AI 检查的价值被完全抵消。
    const idx = out.findIndex((r) => r.ruleIds.some((ruleId) => p.problem.includes(ruleId)))
    if (idx >= 0) {
      const prev = out[idx]!
      // 保留静态的 id 与 ruleIds（位置对应，避免编号跳号），内容换成 AI 详细版
      out[idx] = toRec(prev.ruleIds, prev.id)
      continue
    }
    if (out.some((r) => r.title === p.title)) continue // 标题相同视为同一条，不重复追加
    // AI 自己从 OPT-001 开始编号，与静态建议必然撞号：冲突则分配未占用的编号
    const used = new Set(out.map((r) => r.id))
    let id = p.id
    if (used.has(id)) {
      let n = 1
      do {
        id = `OPT-${String(n).padStart(3, "0")}`
        n += 1
      } while (used.has(id))
    }
    out.push(toRec([], id))
  }
  return out
}
