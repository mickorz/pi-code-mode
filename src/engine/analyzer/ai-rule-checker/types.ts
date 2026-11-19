/**
 * AI Rule Checker 数据契约（P1，2026-11-19）
 *
 * 与 Planner 的区别（这是本次升级的核心）：
 *  - Planner：消费静态 finding 摘要 → 给优化建议（不发现新问题）
 *  - Rule Checker：读 rule.md + 完整源码 → 逐条独立判定 pass/hit/uncertain
 *
 * 硬约束（防幻觉）：
 *  - 每个 hit 必须有 evidence（文件 + 行号 + 原文 quote）
 *  - quote 必须能在源码里找到，否则整条丢弃
 *  - confidence < 0.5 只能落 uncertain，不进入风险分
 *  - ruleId 必须存在于 BUILTIN_RULES
 */
import type { Severity } from "../types.js"

export type AIRuleStatus = "hit" | "pass" | "uncertain" | "not-applicable" | "error"

export interface AIRuleEvidence {
  file: string
  startLine: number
  endLine: number
  /** 原文引文（用于校验，必须能在源码中匹配） */
  quote: string
}

export interface AIRuleCheck {
  ruleId: string
  status: AIRuleStatus
  /** 0..1；< 0.5 强制降级为 uncertain */
  confidence: number
  source: "ai"
  evidence: AIRuleEvidence[]
  /** 按 rule.md 的解释说明为什么是这个结论 */
  reason: string
  impact?: string
  suggestion?: string
  validation?: string[]
  /** 校验失败原因（status=error 或证据被丢弃时） */
  error?: string
}

/** 一次 AI Rule Check 的完整结果 */
export interface AIRuleCheckResult {
  /** completed = 全部规则组成功；partial = 部分失败；failed = 全部失败；skipped = 未启用 */
  status: "completed" | "partial" | "failed" | "skipped"
  checks: AIRuleCheck[]
  diagnostics: string[]
  /** 实际耗时（毫秒），便于报告展示与超时判断 */
  durationMs?: number
}

export interface AIRuleCheckRule {
  id: string
  severity: Severity
  description: string
  /** rule.md 全文（规则基准） */
  doc: string
}

/** 静态与 AI 的合并结论 */
export type MergedRuleStatus = "pass" | "static-hit" | "ai-hit" | "both" | "conflict" | "uncertain" | "error"

export interface MergedRuleResult {
  ruleId: string
  severity: Severity
  description: string
  staticStatus: "hit" | "pass" | "error"
  staticHits: number
  staticError?: string
  aiStatus?: AIRuleStatus
  aiConfidence?: number
  aiEvidenceCount: number
  /** 合并后给报告/Dashboard 用的最终状态 */
  finalStatus: MergedRuleStatus
  /** 需要人工确认时给出原因 */
  note?: string
}
