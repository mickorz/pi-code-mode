/**
 * 问题簇合并契约（2026-11-19）
 *
 * 背景：真实目录分析 37 条 finding 里 RETRY-001×12、IO-001×11、SERIAL-002×9
 * 本质各是同一个问题。逐条平铺让报告从「告诉你改什么」退化成「给一堆行号」。
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import { clusterFindings, clusterKeyOf } from "../../src/engine/analyzer/report-builder.js"
import type { AnalysisFindingWithSnippet } from "../../src/engine/analyzer/report-builder.js"

function f(over: Partial<AnalysisFindingWithSnippet> & { ruleId: string }): AnalysisFindingWithSnippet {
  return {
    severity: "medium",
    confidence: 0.7,
    location: { startLine: 10, endLine: 20 },
    evidence: ["证据"],
    ...over,
  } as AnalysisFindingWithSnippet
}

test("clusterFindings：同规则多条合并为一个簇", () => {
  const clusters = clusterFindings([
    f({ ruleId: "RETRY-001", location: { startLine: 10, endLine: 20, file: "a.js" } }),
    f({ ruleId: "RETRY-001", location: { startLine: 30, endLine: 40, file: "b.js" } }),
    f({ ruleId: "RETRY-001", location: { startLine: 50, endLine: 60, file: "b.js" } }),
  ])
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0]!.count, 3)
  assert.deepEqual(clusters[0]!.files, ["a.js", "b.js"], "文件去重")
  assert.equal(clusters[0]!.locations.length, 3)
})

test("clusterFindings：不同规则各自成簇", () => {
  const clusters = clusterFindings([
    f({ ruleId: "RETRY-001" }),
    f({ ruleId: "IO-001" }),
    f({ ruleId: "SERIAL-002" }),
  ])
  assert.equal(clusters.length, 3)
})

test("INPUT-001 按标识符拆分（不同对象是不同问题，不能合并）", () => {
  const a = f({ ruleId: "INPUT-001", evidence: ["标识符 `allRequirements` 在 3 个调用中出现"] })
  const b = f({ ruleId: "INPUT-001", evidence: ["标识符 `ruleDocs` 在 2 个调用中出现"] })
  assert.notEqual(clusterKeyOf(a), clusterKeyOf(b))
  const clusters = clusterFindings([a, b, { ...a, location: { startLine: 99, endLine: 99 } }])
  assert.equal(clusters.length, 2, "两个标识符 → 两个簇")
  const allReq = clusters.find((c) => c.key.includes("allRequirements"))!
  assert.equal(allReq.count, 2, "同一标识符的多条合并")
})

test("clusterFindings：位置超过 10 条时截断并计数", () => {
  const many = Array.from({ length: 14 }, (_, i) => f({ ruleId: "IO-001", location: { startLine: i + 1, endLine: i + 2 } }))
  const [c] = clusterFindings(many)
  assert.equal(c!.count, 14)
  assert.equal(c!.locations.length, 10, "最多列 10 条位置")
  assert.equal(c!.moreLocations, 4, "其余计入 moreLocations")
})

test("clusterFindings：严重度取最重、置信度取最高", () => {
  const [c] = clusterFindings([
    f({ ruleId: "X-001", severity: "low", confidence: 0.5 }),
    f({ ruleId: "X-001", severity: "high", confidence: 0.9 }),
    f({ ruleId: "X-001", severity: "medium", confidence: 0.7 }),
  ])
  assert.equal(c!.severity, "high")
  assert.equal(c!.confidence, 0.9)
})

test("clusterFindings：排序为严重度优先，再按条数降序", () => {
  const clusters = clusterFindings([
    f({ ruleId: "A-001", severity: "low" }),
    f({ ruleId: "B-001", severity: "low" }),
    f({ ruleId: "B-001", severity: "low" }),
    f({ ruleId: "C-001", severity: "high" }),
  ])
  assert.equal(clusters[0]!.ruleId, "C-001", "high 排最前")
  assert.equal(clusters[1]!.ruleId, "B-001", "同严重度下条数多的在前")
})

test("clusterFindings：证据去重且最多 6 条", () => {
  const many = Array.from({ length: 10 }, (_, i) => f({ ruleId: "X-001", evidence: [`证据${i}`, "公共证据"] }))
  const [c] = clusterFindings(many)
  assert.ok(c!.evidence.length <= 6, `证据应截断到 6 条，实际 ${c!.evidence.length}`)
  assert.equal(new Set(c!.evidence).size, c!.evidence.length, "证据必须去重")
})

test("clusterFindings：保留建议与代表代码片段", () => {
  const [c] = clusterFindings([
    f({ ruleId: "X-001", suggestion: "改法", snippet: "const a = 1" }),
    f({ ruleId: "X-001", location: { startLine: 99, endLine: 99 } }),
  ])
  assert.equal(c!.suggestion, "改法")
  assert.equal(c!.snippet, "const a = 1")
})

test("clusterFindings：空输入返回空数组", () => {
  assert.deepEqual(clusterFindings([]), [])
})
