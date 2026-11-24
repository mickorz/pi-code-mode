/**
 * AI Rule Checker 契约测试（P1，2026-11-19）
 *
 * 重点验证防幻觉机制——这是"AI 检查规则"能否可信的前提：
 *  1. 编造引文必须被丢弃
 *  2. 越界行号必须被丢弃
 *  3. hit 无有效证据必须降级 uncertain
 *  4. confidence < 0.5 必须降级 uncertain
 *  5. AI 不能推翻静态结构事实（conflict 而非覆盖）
 *  6. 单组失败不阻断其它组（partial）
 */
import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"

import { loadRuleDocs } from "../../packages/engine/src/analyzer/ai-rule-checker/rule-doc-loader.js"
import { BUILTIN_RULES } from "../../packages/engine/src/analyzer/rules/index.js"
import { parseChecks, runAIRuleCheck } from "../../packages/engine/src/analyzer/ai-rule-checker/ai-rule-checker.js"
import { validateCheck } from "../../packages/engine/src/analyzer/ai-rule-checker/evidence-validator.js"
import { buildSourceContext, toSourceFiles } from "../../packages/engine/src/analyzer/ai-rule-checker/prompt-builder.js"
import { aiOnlyHits, mergeRuleResults, needsHumanReview } from "../../packages/engine/src/analyzer/ai-rule-checker/result-merger.js"
import type { AIRuleCheck } from "../../packages/engine/src/analyzer/ai-rule-checker/types.js"

const SOURCE = `export const meta = { name: 'demo' }
const A = args || {}
const x = await agent('读一批文件', { retries: 2, timeoutMs: 600000 })
const y = await agent('再读一批文件', { retries: 2, timeoutMs: 600000 })
return x + y
`
const SOURCES = toSourceFiles([{ file: "demo.js", content: SOURCE }])

function check(partial: Partial<AIRuleCheck>): AIRuleCheck {
  return {
    ruleId: "RETRY-001",
    status: "hit",
    confidence: 0.9,
    source: "ai",
    evidence: [],
    reason: "test",
    ...partial,
  }
}

test("loadRuleDocs：每条内置规则都有文档（数量随 BUILTIN_RULES 增长）", () => {
  const { rules, problems } = loadRuleDocs()
  assert.deepEqual(problems, [], `规则文档问题：${problems.join("; ")}`)
  assert.equal(rules.length, BUILTIN_RULES.length, "规则数与文档数必须一致")
  assert.ok(rules.length >= 10, `至少 10 条（含 REC-002），实际 ${rules.length}`)
  for (const r of rules) assert.ok(r.doc.length > 100, `${r.id} 文档过短`)
})

test("buildSourceContext：只给关键行窗口，不塞整文件", () => {
  const big = Array.from({ length: 500 }, (_, i) => (i === 250 ? "await agent('x')" : `const v${i} = ${i}`)).join("\n")
  const ctx = buildSourceContext([{ file: "big.js", content: big }])
  assert.ok(ctx.length < big.length, "上下文必须比整文件小")
  assert.ok(ctx.includes("await agent('x')"), "必须包含关键行")
  assert.ok(ctx.includes("250|"), "必须带行号")
})

test("validateCheck：编造引文被丢弃并降级 uncertain", () => {
  const { check: out, dropped } = validateCheck(
    check({ evidence: [{ file: "demo.js", startLine: 3, endLine: 3, quote: "这段代码根本不存在" }] }),
    SOURCES,
  )
  assert.equal(out.status, "uncertain", "无有效证据的 hit 必须降级")
  assert.equal(out.evidence.length, 0)
  assert.ok(dropped.length === 1 && dropped[0]!.includes("找不到"), `应记录丢弃原因：${dropped.join(",")}`)
})

test("validateCheck：越界行号被丢弃", () => {
  const { dropped } = validateCheck(
    check({ evidence: [{ file: "demo.js", startLine: 9999, endLine: 10000, quote: "const x" }] }),
    SOURCES,
  )
  assert.ok(dropped.some((d) => d.includes("越界")), `应报行号越界：${dropped.join(",")}`)
})

test("validateCheck：文件不在集合内被丢弃", () => {
  const { dropped } = validateCheck(
    check({ evidence: [{ file: "other.js", startLine: 1, endLine: 1, quote: "const x" }] }),
    SOURCES,
  )
  assert.ok(dropped.some((d) => d.includes("不在本次分析集合")), `应报文件越界：${dropped.join(",")}`)
})

test("validateCheck：真实引文保留", () => {
  const { check: out, dropped } = validateCheck(
    check({ evidence: [{ file: "demo.js", startLine: 3, endLine: 3, quote: "await agent('读一批文件', { retries: 2" }] }),
    SOURCES,
  )
  assert.equal(out.status, "hit")
  assert.equal(out.evidence.length, 1)
  assert.deepEqual(dropped, [])
})

test("validateCheck：低置信度强制降级 uncertain", () => {
  const { check: out } = validateCheck(
    check({ confidence: 0.3, evidence: [{ file: "demo.js", startLine: 3, endLine: 3, quote: "retries: 2" }] }),
    SOURCES,
  )
  assert.equal(out.status, "uncertain")
  assert.ok(String(out.error).includes("0.5"))
})

test("parseChecks：容忍 markdown 围栏与前后文字", () => {
  const raw = '这是结果：\n```json\n{"checks":[{"ruleId":"RETRY-001","status":"hit","confidence":0.8,"reason":"r","evidence":[]}]}\n```\n以上。'
  const r = parseChecks(raw)
  assert.equal(r.ok, true)
  assert.equal(r.checks[0]!.ruleId, "RETRY-001")
})

test("parseChecks：无 JSON 时失败且给出原因", () => {
  const r = parseChecks("抱歉我无法完成")
  assert.equal(r.ok, false)
  assert.ok(r.error)
})

test("mergeRuleResults：AI 不能推翻静态结构事实（conflict）", () => {
  const merged = mergeRuleResults(
    [{ id: "RETRY-001", severity: "low", description: "d", hits: 2, status: "hit" }],
    [check({ status: "pass", evidence: [], confidence: 0.9 })],
  )
  assert.equal(merged[0]!.finalStatus, "conflict", "静态 hit + AI pass 须标冲突，不能覆盖")
  assert.ok(merged[0]!.note?.includes("人工复核"))
})

test("mergeRuleResults：AI 补上静态没发现的问题（ai-hit）", () => {
  const merged = mergeRuleResults(
    [{ id: "REC-001", severity: "high", description: "d", hits: 0, status: "pass" }],
    [check({ ruleId: "REC-001", status: "hit", evidence: [{ file: "demo.js", startLine: 3, endLine: 3, quote: "retries: 2" }] })],
  )
  assert.equal(merged[0]!.finalStatus, "ai-hit", "静态 pass + AI hit 是本次升级的核心增量")
  assert.equal(merged[0]!.aiEvidenceCount, 1)
  assert.equal(aiOnlyHits(merged).length, 1)
})

test("mergeRuleResults：两侧都命中记 both", () => {
  const merged = mergeRuleResults(
    [{ id: "RETRY-001", severity: "low", description: "d", hits: 2, status: "hit" }],
    [check({ status: "hit", evidence: [{ file: "demo.js", startLine: 3, endLine: 3, quote: "retries: 2" }] })],
  )
  assert.equal(merged[0]!.finalStatus, "both")
})

test("mergeRuleResults：uncertain 进人工复核清单", () => {
  const merged = mergeRuleResults(
    [{ id: "SERIAL-002", severity: "medium", description: "d", hits: 0, status: "pass" }],
    [check({ ruleId: "SERIAL-002", status: "uncertain", confidence: 0.4 })],
  )
  assert.equal(merged[0]!.finalStatus, "uncertain")
  assert.equal(needsHumanReview(merged).length, 1)
})

test("runAIRuleCheck：一组失败仍返回 partial，其余组保留", async () => {
  const { rules } = loadRuleDocs()
  // 分组为 3 组：让含 RETRY-001 的那一组抛错，其它组正常
  // 一条规则一组：只让 RETRY-001 失败
  const failIds = ["RETRY-001"]
  const failCopy = rules.filter((r) => failIds.includes(r.id))
  let call = 0
  const fake = async (prompt: string) => {
    call += 1
    if (prompt.includes("规则 RETRY-001")) throw new Error("模拟超时")
    // 只返回本组规则（模拟模型行为），用 prompt 里出现的规则 ID 推断
    const present = rules.filter((r) => prompt.includes(`规则 ${r.id}（`))
    return JSON.stringify({
      checks: present.map((r) => ({ ruleId: r.id, status: "pass", confidence: 0.8, reason: "未命中", evidence: [] })),
    })
  }
  const result = await runAIRuleCheck({ rules, sources: SOURCES, staticSummary: "", plannerAgent: fake })
  assert.equal(result.status, "partial", "一组失败应为 partial")
  assert.equal(result.checks.length, rules.length, "每条规则都要有结论")
  assert.equal(result.checks.filter((c) => c.status === "error").length, failCopy.length)
  assert.ok(result.diagnostics.some((d) => d.includes("模拟超时")))
  assert.equal(call, rules.length, "每条规则一次调用")
})

test("runAIRuleCheck：无规则文档时 skipped 而非静默通过", async () => {
  const result = await runAIRuleCheck({ rules: [], sources: SOURCES, staticSummary: "", plannerAgent: async () => "{}" })
  assert.equal(result.status, "skipped")
  assert.ok(result.diagnostics.length > 0)
})

test("runAIRuleCheck：模型输出不可解析时该组记 error", async () => {
  const { rules } = loadRuleDocs()
  const result = await runAIRuleCheck({ rules: rules.slice(0, 2), sources: SOURCES, staticSummary: "", plannerAgent: async () => "我无法检查" })
  assert.equal(result.status, "failed")
  assert.ok(result.checks.every((c) => c.status === "error"))
  assert.ok(result.diagnostics.some((d) => d.includes("输出不可用")))
})
