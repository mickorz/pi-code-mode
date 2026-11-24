/**
 * AI 结果证据校验（防幻觉）
 *
 * 每条 hit 必须能落地到真实源码：文件在集合内、行号在范围内、quote 能在文件中找到。
 * 校验失败直接丢弃该条（不做"尽力保留"）——保留一条编造的 finding 比漏报更糟，
 * 因为它会诱导用户去改不存在的代码。
 */
import type { AIRuleCheck, AIRuleEvidence } from "./types.js"
import type { SourceFile } from "./prompt-builder.js"

/** 归一化：去掉所有空白，用于容忍缩进/换行差异后的匹配 */
function squash(s: string): string {
  return s.replace(/\s+/g, "")
}

export interface ValidateResult {
  check: AIRuleCheck
  /** 被丢弃的证据（校验失败） */
  dropped: string[]
}

/**
 * 校验单条 AI 检查结果。
 * 规则：
 *  - status=hit 且 evidence 为空 → 降级 uncertain
 *  - 证据全部校验失败 → 降级 uncertain 并记录原因
 *  - confidence < 0.5 → 强制 uncertain
 */
/**
 * 按路径后缀匹配源码文件。
 * 实测问题：AI 会把 `game-requirement-audit/1-scan-template.js` 写成 `1-scan-template.js`（或反过来），
 * 严格全等会把真实证据全丢掉，导致所有 hit 被误降级为 uncertain。
 * 取最长匹配，避免 `a/x.js` 与 `b/x.js` 混淆。
 */
function resolveSource(file: string, sources: SourceFile[]): { file: string; content: string } | undefined {
  const norm = (p: string) => p.split("\\").join("/").replace(/^\.\//, "")
  const target = norm(file)
  let best: { file: string; content: string } | undefined
  for (const s of sources) {
    const cand = norm(s.file)
    const match = cand === target || cand.endsWith("/" + target) || target.endsWith("/" + cand)
    if (match && (!best || cand.length > best.file.length)) best = s
  }
  return best
}

export function validateCheck(check: AIRuleCheck, sources: SourceFile[]): ValidateResult {
  const dropped: string[] = []
  const kept: AIRuleEvidence[] = []

  for (const ev of check.evidence ?? []) {
    const resolved = resolveSource(ev.file, sources)
    if (!resolved) {
      dropped.push(`文件不在本次分析集合内：${ev.file}`)
      continue
    }
    const content = resolved.content
    const lineCount = content.split("\n").length
    if (!Number.isFinite(ev.startLine) || ev.startLine < 1 || ev.endLine < ev.startLine || ev.endLine > lineCount) {
      dropped.push(`行号越界：${ev.file} L${ev.startLine}-${ev.endLine}（文件 ${lineCount} 行）`)
      continue
    }
    if (!ev.quote || squash(ev.quote).length < 4) {
      dropped.push(`引文过短或为空：${ev.file} L${ev.startLine}`)
      continue
    }
    // 引文必须在「指定行范围」或「全文」中找到（允许模型行号略偏，但不允许凭空造句子）
    const lines = content.split("\n")
    const slice = lines.slice(Math.max(0, ev.startLine - 1), ev.endLine).join("\n")
    const inRange = squash(slice).includes(squash(ev.quote))
    const inFile = squash(content).includes(squash(ev.quote))
    if (!inRange && !inFile) {
      dropped.push(`引文在源码中找不到：${ev.file} L${ev.startLine}-${ev.endLine}「${ev.quote.slice(0, 40)}」`)
      continue
    }
    kept.push({ ...ev, file: resolved.file, quote: ev.quote })
  }

  let status = check.status
  let error = check.error
  if (status === "hit" && kept.length === 0) {
    status = "uncertain"
    error = `命中但无有效证据（${dropped.length} 条被丢弃），降级为 uncertain`
  }
  if (status === "hit" && check.confidence < 0.5) {
    status = "uncertain"
    error = `置信度 ${check.confidence.toFixed(2)} < 0.5，降级为 uncertain`
  }
  return { check: { ...check, status, evidence: kept, ...(error ? { error } : {}) }, dropped }
}
