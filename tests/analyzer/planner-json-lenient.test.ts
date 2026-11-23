/**
 * Planner JSON 容错解析（2026-11-23）
 *
 * 背景：真实缺陷 demo 分析时出现
 *   AI 建议校验失败：JSON 解析失败：Expected ',' or ']' after array element in JSON at position 722
 * 严格 JSON.parse 一次失败就整条丢弃 → Planner 建议随机消失。
 *
 * 三级降级每级都必须「校验得通」，不做"救回来半条假数据"。
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import { lenientJsonParse, parsePlannerResponse, repairTruncatedJson, salvageProposals } from "../../src/engine/analyzer/optimization-planner.js"

const GOOD_PROPOSAL = {
  id: "OPT-001",
  title: "提取公共上下文",
  severity: "high",
  target: { startLine: 2, endLine: 4 },
  problem: "allRequirements 被三次注入",
  proposal: { type: "input-reduction", action: "抽取为 Shared Context 引用" },
  dependencyAnalysis: "三次调用均只读该对象，无写入依赖，可安全共享引用",
  expectedImpact: { note: "待 Benchmark 验证" },
  qualityRisk: "high",
  validation: ["确认所有证据可读"],
}

/** 只把 JSON.stringify 的结果截断到指定长度，模拟模型输出被切断 */
function truncateAt(value: unknown, at: number): string {
  return JSON.stringify(value).slice(0, at)
}

test("tier1：合法 JSON 直接解析", () => {
  const text = JSON.stringify({ analysisSummary: "ok", proposals: [GOOD_PROPOSAL] })
  const r = lenientJsonParse(text)
  assert.equal(r.ok, true)
  assert.equal(r.tier, 1)
})

test("tier1：容忍前后解释文字与 markdown 围栏", () => {
  const text = "以下是结果：\n```json\n" + JSON.stringify({ analysisSummary: "ok", proposals: [GOOD_PROPOSAL] }) + "\n```\n以上。"
  const r = lenientJsonParse(text)
  assert.equal(r.ok, true)
  assert.equal(r.tier, 1)
})

test("tier2：截断在数组中段 → 修复括号后可解析", () => {
  const full = JSON.stringify({ analysisSummary: "ok", proposals: [GOOD_PROPOSAL] })
  // 截在 proposals 对象内部（保证前面结构完整）
  const cut = full.indexOf('"dependencyAnalysis"') + 20
  const text = full.slice(0, cut)
  const r = lenientJsonParse(text)
  assert.equal(r.ok, true, r.errors.join("; "))
  assert.ok(r.tier === 2 || r.tier === 3)
})

test("tier2：截断在字符串中间 → 补引号 + 括号", () => {
  const repaired = repairTruncatedJson('{"analysisSummary":"正在说明一半')
  assert.equal(typeof repaired, "string")
  const parsed = JSON.parse(repaired!) as { analysisSummary: string }
  assert.match(parsed.analysisSummary, /正在说明一半/)
})

test("tier2：截断在数字/逗号后 → 去掉残逗号再闭合", () => {
  const repaired = repairTruncatedJson('{"a":1,"b":[1,2,')
  assert.equal(typeof repaired, "string")
  assert.doesNotThrow(() => JSON.parse(repaired!))
})

test("tier2：括号不匹配 → 放弃修复（不抛错）", () => {
  assert.equal(repairTruncatedJson('{"a":1}}'), undefined)
})

test("tier3：最后一个 proposal 被截断 → 抢救前面完整的", () => {
  const second = { ...GOOD_PROPOSAL, id: "OPT-002", title: "第二条建议" }
  const full = JSON.stringify({ analysisSummary: "总结", proposals: [GOOD_PROPOSAL, second] })
  // 截在第二个对象内部
  const cut = full.lastIndexOf('"dependencyAnalysis"') + 10
  const salvaged = salvageProposals(full.slice(0, cut))
  assert.ok(salvaged, "应能抢救出至少一条")
  const proposals = (salvaged!.value as { proposals: unknown[] }).proposals
  assert.equal(proposals.length, 1, "只保留完整的那个对象")
  assert.equal((proposals[0] as { id: string }).id, "OPT-001")
  assert.equal((salvaged!.value as { analysisSummary: string }).analysisSummary, "总结")
})

test("tier3：字符串里含花括号不会误判对象边界", () => {
  const tricky = { ...GOOD_PROPOSAL, problem: "表达式 {a:1} 与 ] 混在字符串里" }
  const full = JSON.stringify({ analysisSummary: "s", proposals: [tricky, GOOD_PROPOSAL] })
  const cut = full.lastIndexOf('"dependencyAnalysis"') + 5
  const salvaged = salvageProposals(full.slice(0, cut))
  assert.ok(salvaged)
  const proposals = (salvaged!.value as { proposals: Array<{ problem?: string }> }).proposals
  assert.equal(proposals.length, 1)
  assert.match(proposals[0]!.problem ?? "", /字符串里/)
})

test("parsePlannerResponse：截断在结构位置（字段完整）→ tier2 修复后可用", () => {
  const full = JSON.stringify({ analysisSummary: "总结", proposals: [GOOD_PROPOSAL] })
  // 截在根对象的 `]` 之前：所有字段都完整，只是没闭合
  const cut = full.lastIndexOf("]")
  const r = parsePlannerResponse(full.slice(0, cut))
  assert.equal(r.ok, true, r.errors.join("; "))
  assert.equal(r.output!.proposals.length, 1)
  assert.equal(r.output!.proposals[0]!.title, "提取公共上下文")
})

test("parsePlannerResponse：第二个 proposal 字段残缺 → 丢掉残条、保住完整的", () => {
  const second = { ...GOOD_PROPOSAL, id: "OPT-002", title: "第二条" }
  const full = JSON.stringify({ analysisSummary: "总结", proposals: [GOOD_PROPOSAL, second] })
  // 截在第二个对象的 validation 之前（第二个字段不全）
  const cut = full.lastIndexOf('"validation"')
  const r = parsePlannerResponse(full.slice(0, cut))
  assert.equal(r.ok, true, r.errors.join("; "))
  assert.equal(r.output!.proposals.length, 1)
  assert.equal(r.output!.proposals[0]!.id, "OPT-001")
})

test("parsePlannerResponse：完全不是 JSON → 明确失败（不假装成功）", () => {
  const r = parsePlannerResponse("抱歉我无法完成这个分析")
  assert.equal(r.ok, false)
  assert.ok(r.errors.length > 0)
})

test("parsePlannerResponse：JSON 合法但字段不全 → 校验层拒绝", () => {
  const r = parsePlannerResponse(JSON.stringify({ analysisSummary: "s", proposals: [{ id: "X" }] }))
  assert.equal(r.ok, false, "缺 title/dependencyAnalysis 等必填字段必须拒绝")
})
