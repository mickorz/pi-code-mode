/**
 * M1-T4 契约测试：Analysis Report（结构完整 / 收益不虚构 / 确定性）
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

import { ANALYZER_VERSION, buildReport, renderMarkdown, RULE_SET_VERSION } from "../../src/engine/analyzer/report-builder.js"

const FIX = path.join(import.meta.dirname, "fixtures", "atomic")
const REAL = path.join(import.meta.dirname, "fixtures", "real")
const read = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8")

test("报告结构完整：版本/指纹/风险分/估算/调用图/依赖/建议", () => {
  const r = buildReport({ source: read("repeated-context.js"), file: "repeated-context.js" })
  assert.equal(r.schemaVersion, "1.0")
  assert.equal(r.analyzerVersion, ANALYZER_VERSION)
  assert.equal(r.ruleSetVersion, RULE_SET_VERSION)
  assert.match(r.sourceHash, /^sha256:/)
  assert.ok(r.summary.riskScore >= 0 && r.summary.riskScore <= 100)
  assert.equal(typeof r.executionEstimate.callSites, "number")
  assert.ok(Array.isArray(r.callGraph.nodes))
  assert.ok(Array.isArray(r.dependencies.unknowns))
  assert.ok(Array.isArray(r.recommendations))
})

test("确定性：同源码同 generatedAt → 完全相同输出", () => {
  const src = read("repeated-context.js")
  const a = buildReport({ source: src, file: "x.js", generatedAt: "2026-11-18T00:00:00.000Z" })
  const b = buildReport({ source: src, file: "x.js", generatedAt: "2026-11-18T00:00:00.000Z" })
  assert.deepEqual(a, b)
})

test("sourceHash 由内容决定（不同源码不同指纹）", () => {
  const a = buildReport({ source: "await agent('a')" })
  const b = buildReport({ source: "await agent('b')" })
  assert.notEqual(a.sourceHash, b.sourceHash)
})

test("预期收益不虚构数值（必须标待 Benchmark）", () => {
  const r = buildReport({ source: read("repeated-context.js"), file: "rc.js" })
  assert.ok(r.recommendations.length > 0)
  for (const rec of r.recommendations) {
    assert.match(rec.expectedImpact, /待 Benchmark/)
    assert.ok(rec.validation.length > 0, "每条建议必须有验证条件")
  }
})

test("动态节点：determined=false 且不做精确估算", () => {
  const r = buildReport({ source: read("dynamic-loop.js"), file: "dl.js" })
  assert.equal(r.executionEstimate.determined, false)
  assert.ok(r.executionEstimate.dynamicNodes >= 1)
})

test("波次估算：静态可确定时给出 waves", () => {
  const src = `
setConcurrency(2)
const groups = new Array(6).fill(0)
await parallel(groups.map(() => () => agent('x')))
`
  const r = buildReport({ source: src })
  assert.equal(r.executionEstimate.concurrency, 2)
  assert.equal(r.executionEstimate.estimatedWaves, 3)
})

test("Markdown 渲染含关键段落", () => {
  const r = buildReport({ source: read("repeated-context.js"), file: "rc.js" })
  const md = renderMarkdown(r)
  assert.match(md, /# Workflow Analysis/)
  assert.match(md, /Risk Score/)
  assert.match(md, /## 调用结构/)
  assert.match(md, /## 发现的问题/)
  assert.match(md, /## 优化建议/)
  assert.match(md, /待 Benchmark/)
})

test("真实脚本 S8 报告可生成且 JSON 可序列化", () => {
  const src = fs.readFileSync(path.join(REAL, "8-difference-review.js"), "utf8")
  const r = buildReport({ source: src, file: "8-difference-review.js" })
  const json = JSON.stringify(r)
  assert.ok(json.length > 500)
  const parsed = JSON.parse(json)
  assert.equal(parsed.file, "8-difference-review.js")
})
