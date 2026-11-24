/**
 * review.md 渲染（O1）
 *
 * 用户唯一需要读的文件：原问题 → 改了什么叫 → 为什么这么改 → 验证到什么程度 → 能否应用。
 * 不在这里做任何判断，只陈述 session 与产物中的事实。
 */
import type { OptimizationSession, PatchSet, PatchReview } from "./session-types.js"

export interface ReviewInput {
  session: OptimizationSession
  /** 原问题簇（来自 before report） */
  clusters: Array<{
    ruleId: string
    count: number
    severity: string
    confidence: number
    files: string[]
    locations: string[]
    evidence: string[]
    suggestion?: string
  }>
  patch?: PatchSet
  patchReview?: PatchReview
  /**
   * 各选中簇的处理情况。缺省时按「有补丁则全部算已处理」推断。
   *
   * 必要性：实测选中 4 个簇却只改了 1 处时，读者必须知道另 3 个为什么没改，
   * 否则会以为被静默丢弃了。
   */
  clusterOutcome?: Array<{ ruleId: string; status: "handled" | "skipped" | "needs-human"; reason?: string }>
  /** before → after 的 unified diff（按文件） */
  diffs?: Array<{ path: string; diff: string }>
  /** 静态复检结论 */
  staticAfter?: { totalFindings: number; targetRuleResolved: boolean; ruleStatus?: string }
  /** 结构校验问题 */
  patchIssues?: string[]
  /** 不能自动优化的原因 */
  blockers?: string[]
}

export function renderReview(input: ReviewInput): string {
  const s = input.session
  const lines: string[] = []

  lines.push(`# 优化审阅：${s.id}`)
  lines.push("")
  lines.push(`- 状态：**${s.status}**`)
  lines.push(`- 目标：\`${s.target.ref}\`（${s.target.kind}，${s.target.files.length} 个 js）`)
  lines.push(`- 选中问题簇：${s.selectedClusters.join(", ") || "（无）"}`)
  lines.push(`- 模型：生成 \`${s.model.generatorTier}\`${s.model.generatorModel ? `（${s.model.generatorModel}）` : ""} / 审查 \`${s.model.reviewerTier}\`${s.model.reviewerModel ? `（${s.model.reviewerModel}）` : ""}`)
  lines.push("")
  lines.push("> 原文件在 optimize 阶段**未做任何修改**。只有执行 `optimize apply` 才会写回。")
  lines.push("")

  // ---- 1. 原问题簇 ----
  lines.push("## 1. 原问题簇")
  lines.push("")
  // 处理情况索引（未给时：有补丁=已处理，无补丁=跳过）
  const handledRules = new Set(
    (input.patch?.files ?? []).flatMap((f) => f.edits.map((e) => e.relatedCluster)),
  )
  const outcomeByRule = new Map<string, { status: string; reason?: string }>()
  if (input.clusterOutcome?.length) {
    for (const o of input.clusterOutcome) outcomeByRule.set(o.ruleId, { status: o.status, ...(o.reason ? { reason: o.reason } : {}) })
  }
  const OUTCOME_LABEL: Record<string, string> = { handled: "已处理", skipped: "未处理", "needs-human": "待人工" }

  for (const c of input.clusters) {
    const oc = outcomeByRule.get(c.ruleId)
    const status = oc?.status ?? (handledRules.has(c.ruleId) ? "handled" : "skipped")
    const badge = OUTCOME_LABEL[status] ?? status
    lines.push(`### ${c.ruleId}（${c.count} 处，${c.severity}，置信度 ${c.confidence.toFixed(2)}）— **${badge}**`)
    lines.push("")
    if (oc?.reason) lines.push(`- 说明：${oc.reason}`)
    lines.push(`- 涉及文件：${c.files.join(", ") || "-"}`)
    lines.push(`- 位置：${c.locations.slice(0, 8).join("；")}${c.locations.length > 8 ? " …" : ""}`)
    for (const e of c.evidence.slice(0, 4)) lines.push(`- ${e}`)
    if (c.suggestion) lines.push(`- 静态建议：${c.suggestion}`)
    lines.push("")
  }

  // 汇总一行：选中 N 个，已处理 M，未处理 K —— 避免只改 1 处时读者误以为全部完成
  const summaryCounts = { handled: 0, skipped: 0, "needs-human": 0 } as Record<string, number>
  for (const c of input.clusters) {
    const oc = outcomeByRule.get(c.ruleId)
    const status = oc?.status ?? (handledRules.has(c.ruleId) ? "handled" : "skipped")
    summaryCounts[status] = (summaryCounts[status] ?? 0) + 1
  }
  lines.push(
    `**选中 ${input.clusters.length} 个簇：已处理 ${summaryCounts.handled} / 未处理 ${summaryCounts.skipped} / 待人工 ${summaryCounts["needs-human"]}**`,
  )
  lines.push("")

  // ---- 2. 修改意图 ----
  lines.push("## 2. 修改意图")
  lines.push("")
  if (!input.patch || input.patch.files.length === 0) {
    lines.push("（没有生成补丁）")
    lines.push("")
  } else {
    for (const f of input.patch.files) {
      lines.push(`### ${f.path}`)
      lines.push("")
      for (const e of f.edits) {
        lines.push(`- L${e.startLine}-${e.endLine}（关联 ${e.relatedCluster}）：${e.rationale}`)
      }
      lines.push("")
    }
  }
  // needsHumanDecision 必须**独立于 files 渲染**：
  // 「需要人工决策」恰恰是 files 为空的场景，旧实现把它放进 else 分支，
  // 结果模型给的原因与分步方案在 review.md 里完全看不到。
  if (input.patch?.needsHumanDecision?.length) {
    lines.push("### 需要人工决策（模型未擅自处理）")
    lines.push("")
    for (const d of input.patch.needsHumanDecision) {
      lines.push(`**${d.cluster}**`)
      lines.push("")
      for (const ln of d.question.split("\n")) lines.push(ln)
      lines.push("")
      if (d.options.length > 0) {
        lines.push("可选方案：")
        lines.push("")
        for (const o of d.options) lines.push(`- ${o}`)
        lines.push("")
      }
    }
  }

  // ---- 3. 文件差异 ----
  lines.push("## 3. 文件差异")
  lines.push("")
  if (!input.diffs || input.diffs.length === 0) {
    lines.push("（无差异）")
    lines.push("")
  } else {
    for (const d of input.diffs) {
      lines.push(`### ${d.path}`)
      lines.push("")
      lines.push("```diff")
      lines.push(d.diff.trimEnd())
      lines.push("```")
      lines.push("")
    }
  }

  // ---- 4. 验证状态 ----
  lines.push("## 4. 验证状态")
  lines.push("")
  const v = s.validation
  const mark = (x?: string) => (x === "pass" ? "通过" : x === "fail" ? "**失败**" : x === "partial" ? "部分通过" : x === "pending" ? "待执行" : x === "unavailable" ? "不可用" : "未执行")
  lines.push(`| 检查 | 结果 |`)
  lines.push(`| --- | --- |`)
  lines.push(`| 补丁结构校验 | ${mark(v.patchSchema)} |`)
  lines.push(`| 生产文件未被改动 | ${mark(v.sourceUnchanged)} |`)
  lines.push(`| 静态复检 | ${mark(v.static)}${input.staticAfter ? `（问题 ${input.staticAfter.totalFindings} 条${input.staticAfter.targetRuleResolved ? "，目标规则已解决" : ""}）` : ""} |`)
  lines.push(`| AI Rule Check | ${mark(v.aiRuleCheck)} |`)
  lines.push(`| 真实 Benchmark | ${mark(v.benchmark)} |`)
  lines.push(`| 质量门 | ${mark(v.quality)} |`)
  lines.push("")

  if (input.patchReview) {
    lines.push(`### 补丁审查（${input.patchReview.decision}）`)
    lines.push("")
    if (input.patchReview.findings.length === 0) lines.push("未发现问题。")
    for (const f of input.patchReview.findings) {
      lines.push(`- **${f.severity}** ${f.file}：${f.reason}`)
      if (f.evidence) lines.push(`  > ${f.evidence.slice(0, 200)}`)
    }
    lines.push("")
  }

  if (input.patchIssues?.length) {
    lines.push("### 结构校验问题")
    lines.push("")
    for (const i of input.patchIssues) lines.push(`- ${i}`)
    lines.push("")
  }

  // ---- 5. 结论 ----
  lines.push("## 5. 结论")
  lines.push("")
  if (input.blockers?.length) {
    for (const b of input.blockers) lines.push(`- ${b}`)
  }
  const canApply = s.status === "ready"
  lines.push("")
  lines.push(
    canApply
      ? `可申请写回：\`/workflows optimize apply ${s.id}\``
      : `当前不可写回（状态 ${s.status}）。${v.benchmark === "pending" || v.benchmark === "unavailable" ? "需要真实 Benchmark 与质量门通过。" : ""}`,
  )
  lines.push("")
  return lines.join("\n")
}
