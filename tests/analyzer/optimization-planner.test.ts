/**
 * M1-T5 契约测试：AI Optimization Planner（无模型，验 Schema 与校验规则）
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

import {
  buildPlannerPrompt,
  mergeRecommendations,
  parsePlannerResponse,
  validatePlannerOutput,
} from "../../src/engine/analyzer/optimization-planner.js"
import { buildReport } from "../../src/engine/analyzer/report-builder.js"

const FIX = path.join(import.meta.dirname, "fixtures", "atomic")
const read = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8")

const goodProposal = {
  id: "OPT-001",
  title: "提取公共上下文",
  severity: "high",
  target: { file: "rc.js", startLine: 2, endLine: 4 },
  problem: "allRequirements 被三次注入",
  proposal: { type: "input-reduction", action: "抽取为 Shared Context 引用，保留原文可读" },
  dependencyAnalysis: "三次调用均只读该对象，无写入依赖，可安全共享引用",
  expectedImpact: { note: "待 Benchmark 验证" },
  qualityRisk: "high",
  qualityRiskNote: "压缩可能丢证据，必须保留 Evidence Reference",
  validation: ["确认所有证据可读", "需求覆盖率不下降"],
}

test("buildPlannerPrompt：包含硬性要求、报告摘要、禁止虚构收益", () => {
  const report = buildReport({ source: read("repeated-context.js"), file: "rc.js" })
  const prompt = buildPlannerPrompt(report, { codeSnippet: "const x = 1" })
  assert.match(prompt, /不得虚构数值收益/)
  assert.match(prompt, /待 Benchmark/)
  assert.match(prompt, /Evidence Reference/)
  assert.match(prompt, /## 分析报告摘要/)
  assert.match(prompt, /## Findings/)
  assert.match(prompt, /## 相关代码片段/)
  assert.ok(prompt.length < 8000, `prompt 过长 ${prompt.length}`)
})

test("validatePlannerOutput：合法输出通过", () => {
  const r = validatePlannerOutput({ analysisSummary: "ok", proposals: [goodProposal] })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.output!.proposals[0]!.title, "提取公共上下文")
})

test("validatePlannerOutput：泛泛建议（缺依赖分析/验证）被拒", () => {
  const bad = { ...goodProposal, dependencyAnalysis: "", validation: [] }
  const r = validatePlannerOutput({ analysisSummary: "x", proposals: [bad] })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /dependencyAnalysis/.test(e)))
  assert.ok(r.errors.some((e) => /validation/.test(e)))
})

test("validatePlannerOutput：无基准却给百分比 → 自动改写为待 Benchmark", () => {
  const p = { ...goodProposal, expectedImpact: { note: "预计减少 40% token" } }
  const r = validatePlannerOutput({ analysisSummary: "x", proposals: [p] })
  assert.equal(r.ok, true)
  assert.match(r.output!.proposals[0]!.expectedImpact.note, /待 Benchmark/)
})

test("validatePlannerOutput：proposal.action 缺失被拒（不可执行的建议）", () => {
  const p = { ...goodProposal, proposal: { type: "x" } }
  const r = validatePlannerOutput({ analysisSummary: "x", proposals: [p] })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /proposal\.action/.test(e)))
})

test("parsePlannerResponse：容忍 markdown 围栏与前后文字", () => {
  const text = "分析如下：\n```json\n" + JSON.stringify({ analysisSummary: "s", proposals: [goodProposal] }) + "\n```\n以上。"
  const r = parsePlannerResponse(text)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
})

test("parsePlannerResponse：无 JSON 时报错", () => {
  const r = parsePlannerResponse("我觉得可以并行化（没有任何 JSON）")
  assert.equal(r.ok, false)
})

test("mergeRecommendations：静态建议保留，AI 建议去重叠加", () => {
  const report = buildReport({ source: read("repeated-context.js"), file: "rc.js" })
  const ai = validatePlannerOutput({ analysisSummary: "s", proposals: [goodProposal] }).output
  const merged = mergeRecommendations(report.recommendations, ai)
  assert.ok(merged.length >= report.recommendations.length)
  assert.ok(merged.some((r) => r.title === "提取公共上下文"))
  // 静态建议的收益文案不被覆盖
  const statics = merged.filter((r) => r.ruleIds.length > 0)
  assert.ok(statics.every((r) => /待 Benchmark/.test(r.expectedImpact)))
})

test("mergeRecommendations：AI 缺失时仅返回静态建议", () => {
  const report = buildReport({ source: read("repeated-context.js") })
  assert.deepEqual(mergeRecommendations(report.recommendations, undefined), report.recommendations)
})
