/**
 * M5-T3/T4/T5 契约测试：建议回评 + 基准常态化 + 优化闭环授权闸门
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { renderReview, reviewSuggestions, type SuggestionClaim } from "../../src/engine/evaluator/suggestion-review.js"
import { renderLoopResult, runOptimizationLoop } from "../../src/engine/evaluator/optimization-loop.js"
import { buildReport } from "../../src/engine/analyzer/report-builder.js"
import type { AnalysisReport, Recommendation } from "../../src/engine/analyzer/report-builder.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m5-case-"))

const claim: SuggestionClaim = { id: "OPT-001", title: "减少重复上下文", metric: "inputTokens", claim: "improve", qualityRisk: "high" }

test("回评：实际改善 → effective + credible", () => {
  const r = reviewSuggestions([claim], { "OPT-001": { before: { inputTokens: 100000 }, after: { inputTokens: 60000 } } })
  assert.equal(r.verdicts[0]!.effective, true)
  assert.equal(r.verdicts[0]!.improvement, 0.4)
  assert.equal(r.verdicts[0]!.credible, true)
  assert.equal(r.summary.credibilityScore, 1)
})

test("回评：无改善 → 不可信（不能自证有效）", () => {
  const r = reviewSuggestions([claim], { "OPT-001": { before: { inputTokens: 100000 }, after: { inputTokens: 99000 } } })
  assert.equal(r.verdicts[0]!.effective, false)
  assert.equal(r.verdicts[0]!.credible, false)
  assert.ok(r.verdicts[0]!.notes.some((n) => /< 阈值/.test(n)))
})

test("回评：改善但证据覆盖率下降 → 伤质量，不可信", () => {
  const r = reviewSuggestions([claim], {
    "OPT-001": {
      before: { inputTokens: 100000 },
      after: { inputTokens: 50000 },
      quality: { evidenceCoverageBefore: 1, evidenceCoverageAfter: 0.7 },
    },
  })
  assert.equal(r.verdicts[0]!.effective, true)
  assert.equal(r.verdicts[0]!.qualityDamaged, true)
  assert.equal(r.verdicts[0]!.credible, false, "改善但伤质量必须判不可信")
  assert.equal(r.summary.riskPredictionAccuracy, 1, "标 high 风险且确实伤质量 → 预测准确")
})

test("回评：无实测数据 → 不可信并说明原因", () => {
  const r = reviewSuggestions([claim], {})
  assert.equal(r.verdicts[0]!.credible, false)
  assert.ok(r.verdicts[0]!.notes.some((n) => /无实测数据/.test(n)))
  assert.equal(r.summary.credibilityScore, 0)
})

test("renderReview：Markdown 表格含可信/伤质量列", () => {
  const r = reviewSuggestions([claim], { "OPT-001": { before: { inputTokens: 100 }, after: { inputTokens: 50 } } })
  const md = renderReview(r)
  assert.match(md, /# 优化建议回评/)
  assert.match(md, /可信度评分/)
  assert.match(md, /\| 减少重复上下文 \|/)
})

// ---- 优化闭环 ----

function fakeAnalyze(riskScoreFn: (p: string) => number) {
  return async (scriptPath: string): Promise<AnalysisReport> => {
    // 注入的 analyze 需自行解析路径（闭环传入的是调用方视角的 scriptPath）
    const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(scriptPath)
    const source = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "await agent('x')"
    const r = buildReport({ source, file: scriptPath, generatedAt: "T" })
    return { ...r, summary: { ...r.summary, riskScore: riskScoreFn(scriptPath) } }
  }
}

test("闭环：headless 默认拒绝应用（授权闸门生效）", async () => {
  const dir = tmp()
  const script = path.join(dir, "wf.js")
  fs.writeFileSync(script, "await agent('x')")
  const r = await runOptimizationLoop({
    scriptPath: "wf.js",
    cwd: dir,
    analyze: fakeAnalyze(() => 50),
    propose: async () => ({ recommendations: [{ id: "OPT-1", title: "t", ruleIds: [], severity: "high", expectedImpact: "待 Benchmark", qualityRisk: "low", validation: ["v"] }], patchedSource: "await agent('y')" }),
  })
  assert.equal(r.applied, false)
  assert.equal(r.abortedAt, "confirm")
  assert.equal(fs.readFileSync(script, "utf8"), "await agent('x')", "生产脚本必须未被修改")
  assert.ok(r.workspaceDir)
})

test("闭环：显式授权后才应用（原子写）", async () => {
  const dir = tmp()
  const script = path.join(dir, "wf.js")
  fs.writeFileSync(script, "await agent('x')")
  const r = await runOptimizationLoop({
    scriptPath: "wf.js",
    cwd: dir,
    analyze: fakeAnalyze(() => 50),
    propose: async () => ({ recommendations: [], patchedSource: "await agent('y')" }),
    confirm: async () => true,
  })
  assert.equal(r.applied, true)
  assert.equal(r.ok, true)
  assert.match(fs.readFileSync(script, "utf8"), /agent\('y'\)/)
  assert.match(renderLoopResult(r), /已应用/)
})

test("闭环：重新分析未改善 → 中止（不应用）", async () => {
  const dir = tmp()
  const script = path.join(dir, "wf.js")
  fs.writeFileSync(script, "await agent('x')")
  const r = await runOptimizationLoop({
    scriptPath: "wf.js",
    cwd: dir,
    // 工作区版本风险分更高
    // 工作区路径由闭环用 os.tmpdir() + "m5-loop-" 前缀创建，生产脚本在 "m5-case-" 目录
    analyze: fakeAnalyze((p) => (p.includes("m5-loop-") ? 90 : 50)),
    propose: async () => ({ recommendations: [], patchedSource: "await agent('y')" }),
    confirm: async () => true,
    dangerouslyAutoApprove: false,
  })
  assert.equal(r.applied, false)
  assert.equal(r.abortedAt, "reanalyze")
  assert.equal(fs.readFileSync(script, "utf8"), "await agent('x')")
})

test("闭环：Benchmark 质量降级 → 拒绝应用", async () => {
  const dir = tmp()
  const script = path.join(dir, "wf.js")
  fs.writeFileSync(script, "await agent('x')")
  const r = await runOptimizationLoop({
    scriptPath: "wf.js",
    cwd: dir,
    analyze: fakeAnalyze(() => 50),
    propose: async () => ({ recommendations: [], patchedSource: "await agent('y')" }),
    confirm: async () => true,
    benchmark: async ({ label }) => ({ durationMs: label === "after" ? 100 : 200, qualityOk: label === "before" }),
  })
  assert.equal(r.applied, false)
  assert.equal(r.abortedAt, "reanalyze")
  assert.match(r.reason!, /质量降级/)
})

test("闭环：缺少 patchedSource → 不可应用", async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, "wf.js"), "await agent('x')")
  const r = await runOptimizationLoop({
    scriptPath: "wf.js",
    cwd: dir,
    analyze: fakeAnalyze(() => 50),
    propose: async () => ({ recommendations: [] }),
  })
  assert.equal(r.abortedAt, "workspace-edit")
})

test("闭环：脚本不存在 → 立即失败", async () => {
  const r = await runOptimizationLoop({
    scriptPath: "nope.js",
    cwd: tmp(),
    analyze: fakeAnalyze(() => 0),
    propose: async () => ({ recommendations: [] }),
  })
  assert.equal(r.ok, false)
  assert.match(r.reason!, /不存在/)
})
