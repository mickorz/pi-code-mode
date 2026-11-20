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
  const prompt = buildPlannerPrompt(report)
  assert.match(prompt, /不得虚构数值收益/)
  assert.match(prompt, /待 Benchmark/)
  assert.match(prompt, /Evidence Reference/)
  assert.match(prompt, /## 分析报告摘要/)
  assert.match(prompt, /## Findings/)
  // 不塞源码：2026-11-19 实测 4000 字符源码会让模型 120s+ 零响应
  assert.doesNotMatch(prompt, /## 相关代码片段/)
  // 输出格式必须是「照抄示例」而不是「schema 描述」——后者会让该模型长时间无输出
  assert.match(prompt, /## 输出格式（照抄这个结构）/)
  assert.match(prompt, /\{"analysisSummary":"一句话","proposals":\[/)
  // 体积守卫：瘦身版实测 784 字符；超 1500 视为回退（源码/嵌套列表被塞回来了）
  assert.ok(prompt.length < 1500, `prompt 过长 ${prompt.length}，AI 建议可能超时`)
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

test("mergeRecommendations：同源 AI 建议替换静态建议（不丢弃）", () => {
  const report = buildReport({ source: read("repeated-context.js"), file: "rc.js" })
  // problem 提到静态建议的 ruleId（INPUT-001）→ 判为同源，应替换该条而不是丢弃
  const sameSource = { ...goodProposal, problem: "INPUT-001：allRequirements 被三次注入" }
  const ai = validatePlannerOutput({ analysisSummary: "s", proposals: [sameSource] }).output
  const merged = mergeRecommendations(report.recommendations, ai)
  // 旧实现 `if (dup) continue` 会把同源 AI 建议整条丢弃，用户只能看到静态模板文案
  const replaced = merged.find((r) => r.title === "提取公共上下文")
  assert.ok(replaced, "AI 建议必须出现在结果里（旧实现会丢弃）")
  assert.equal(merged.length, report.recommendations.length, "同源应替换而非追加")
  assert.deepEqual(replaced!.ruleIds, ["INPUT-001"], "替换项应保留静态 ruleIds 关联")
  assert.equal(replaced!.validation.length, 2, "内容应是 AI 版本（2 条验收）")
})

test("mergeRecommendations：不同源 AI 建议追加", () => {
  const report = buildReport({ source: read("repeated-context.js"), file: "rc.js" })
  const ai = validatePlannerOutput({ analysisSummary: "s", proposals: [goodProposal] }).output
  const merged = mergeRecommendations(report.recommendations, ai)
  assert.equal(merged.length, report.recommendations.length + 1, "不同源应追加一条")
  assert.deepEqual(merged.at(-1)!.ruleIds, [], "追加项无静态 ruleId 关联")
})

test("mergeRecommendations：追加的 AI 建议不得与静态 id 撞号", () => {
  const report = buildReport({ source: read("repeated-context.js"), file: "rc.js" })
  // 静态建议已占用 OPT-001..003；AI 也从 OPT-001 起编号（真实模型行为）
  const ai = validatePlannerOutput({
    analysisSummary: "s",
    proposals: [
      { ...goodProposal, id: "OPT-001", title: "全新建议甲", problem: "完全不同的问题甲" },
      { ...goodProposal, id: "OPT-002", title: "全新建议乙", problem: "完全不同的问题乙" },
    ],
  }).output
  const merged = mergeRecommendations(report.recommendations, ai)
  const ids = merged.map((r) => r.id)
  assert.equal(new Set(ids).size, ids.length, `id 必须唯一，实际：${ids.join(",")}`)
  assert.equal(merged.length, report.recommendations.length + 2)
})

test("mergeRecommendations：AI 缺失时仅返回静态建议", () => {
  const report = buildReport({ source: read("repeated-context.js") })
  assert.deepEqual(mergeRecommendations(report.recommendations, undefined), report.recommendations)
})
