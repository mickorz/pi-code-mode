/**
 * 静态结果与 AI 结果的合并
 *
 * 核心原则：**AI 不能覆盖静态结构事实**。
 *  - 静态 hit + AI pass → conflict（静态是正则/算术得出的确定事实，模型判断不能推翻）
 *  - 静态 pass + AI hit → ai-hit（这是升级的核心价值：AI 补上静态看不见的语义问题）
 *  - 两侧都 hit → both
 *  - AI uncertain / error → 单独展示，不进入风险分
 */
import type { MergedRuleResult, AIRuleCheck } from "./types.js"

export interface StaticRuleItem {
  id: string
  severity: string
  description: string
  hits: number
  status: "hit" | "pass" | "error"
  error?: string
}

export function mergeRuleResults(staticRules: StaticRuleItem[], aiChecks: AIRuleCheck[]): MergedRuleResult[] {
  const aiById = new Map(aiChecks.map((c) => [c.ruleId, c]))

  return staticRules.map((sr) => {
    const ai = aiById.get(sr.id)
    const aiStatus = ai?.status
    const aiConfidence = ai?.confidence
    const aiEvidenceCount = ai?.evidence.length ?? 0

    let finalStatus: MergedRuleResult["finalStatus"]
    let note: string | undefined

    if (sr.status === "error") {
      finalStatus = "error"
      note = sr.error ?? "静态规则执行失败"
    } else if (!ai || ai.status === "error") {
      finalStatus = sr.status === "hit" ? "static-hit" : "pass"
      if (ai?.status === "error") note = `AI 检查失败：${ai.error ?? "unknown"}`
    } else if (sr.status === "hit" && ai.status === "hit") {
      finalStatus = "both"
    } else if (sr.status === "hit") {
      // 静态结构事实优先：AI 说不命中也不推翻，但记录冲突供人工复核
      finalStatus = "conflict"
      note = `静态命中 ${sr.hits} 处，AI 判定 ${ai.status}（结构事实优先，请人工复核 AI 结论）`
    } else if (ai.status === "hit") {
      finalStatus = "ai-hit"
      note = ai.reason || undefined
    } else if (ai.status === "uncertain") {
      finalStatus = "uncertain"
      note = ai.reason || undefined
    } else {
      finalStatus = "pass"
    }

    return {
      ruleId: sr.id,
      severity: sr.severity as MergedRuleResult["severity"],
      description: sr.description,
      staticStatus: sr.status,
      staticHits: sr.hits,
      ...(sr.error ? { staticError: sr.error } : {}),
      ...(aiStatus ? { aiStatus } : {}),
      ...(aiConfidence !== undefined ? { aiConfidence } : {}),
      aiEvidenceCount,
      finalStatus,
      ...(note ? { note } : {}),
    }
  })
}

/** 合并后仍需要人工确认的规则（Dashboard/报告里单独列） */
export function needsHumanReview(merged: MergedRuleResult[]): MergedRuleResult[] {
  return merged.filter((m) => m.finalStatus === "uncertain" || m.finalStatus === "conflict" || m.finalStatus === "error")
}

/** 仅 AI 发现的规则（静态没命中、AI 命中）——这是本次升级的核心增量 */
export function aiOnlyHits(merged: MergedRuleResult[]): MergedRuleResult[] {
  return merged.filter((m) => m.finalStatus === "ai-hit")
}
