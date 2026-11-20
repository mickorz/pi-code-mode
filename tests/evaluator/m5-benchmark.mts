/**
 * M5 Benchmark：评估偏差 / 基线回归检测 / 建议回评 / 授权闸门
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { BaselineStore } from "../../src/engine/evaluator/baseline-store.js"
import { evaluate } from "../../src/engine/evaluator/evaluator.js"
import { reviewSuggestions } from "../../src/engine/evaluator/suggestion-review.js"
import { runOptimizationLoop } from "../../src/engine/evaluator/optimization-loop.js"
import { buildReport } from "../../src/engine/analyzer/report-builder.js"

const results: Array<{ name: string; pass: boolean; detail: string }> = []
const check = (n: string, p: boolean, d = "") => results.push({ name: n, pass: p, detail: d })
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m5bench-"))

// 1) 同类输入规模偏差可量化、跨规模不误判
{
  const store = new BaselineStore({ dir: tmp(), minSamples: 3, tolerance: 0.3 })
  for (let i = 0; i < 4; i++) {
    store.record({
      workflowId: "wf",
      scriptHash: "sha256:s",
      report: evaluate({ runId: `r${i}`, inputScale: "48-items", actuals: [{ stageId: "s", agents: 8, inputTokens: 1000, durationMs: 1000 }] }),
    })
  }
  const same = store.detectRegression({ workflowId: "wf", scriptHash: "sha256:s", inputScale: "48-items", actual: { agents: 8, durationMs: 1100, inputTokens: 1000 } })
  check("同规模基线可比较", same.comparable === true)
  const cross = store.detectRegression({ workflowId: "wf", scriptHash: "sha256:s", inputScale: "96-items", actual: { agents: 16, durationMs: 2000, inputTokens: 2000 } })
  check("跨规模不误判（样本不足即不判定）", cross.comparable === false)
}

// 2) 回归检测（人为注入劣化可检出）
{
  const dir = tmp()
  const store = new BaselineStore({ dir, minSamples: 3, tolerance: 0.3 })
  for (let i = 0; i < 4; i++) {
    store.record({ workflowId: "wf2", scriptHash: "sha256:s", report: evaluate({ runId: `r${i}`, actuals: [{ stageId: "s", agents: 4, inputTokens: 1000, durationMs: 1000 }] }) })
  }
  const v = store.detectRegression({ workflowId: "wf2", scriptHash: "sha256:s", actual: { agents: 4, durationMs: 3000, inputTokens: 1000 } })
  check("注入性能回归可检出", v.regressed === true, v.signals.map((s) => `${s.metric}×${s.ratio.toFixed(1)}`).join(","))
}

// 3) 建议回评：有效且未损质量 → 可信
{
  const r = reviewSuggestions(
    [{ id: "OPT-1", title: "提取公共上下文", metric: "inputTokens", claim: "improve", qualityRisk: "high" }],
    { "OPT-1": { before: { inputTokens: 100000 }, after: { inputTokens: 40000 }, quality: { evidenceCoverageBefore: 1, evidenceCoverageAfter: 1 } } },
  )
  check("有效建议判可信", r.verdicts[0]!.credible === true && r.summary.credibilityScore === 1)
}

// 4) 建议回评：改善但伤质量 → 不可信
{
  const r = reviewSuggestions(
    [{ id: "OPT-2", title: "压缩规则", metric: "inputTokens", claim: "improve", qualityRisk: "high" }],
    { "OPT-2": { before: { inputTokens: 100000 }, after: { inputTokens: 30000 }, quality: { evidenceCoverageBefore: 1, evidenceCoverageAfter: 0.6 } } },
  )
  check("伤质量的改善判不可信", r.verdicts[0]!.qualityDamaged === true && r.verdicts[0]!.credible === false)
}

// 5) 授权闸门：headless 不应用
{
  const dir = tmp()
  const script = path.join(dir, "wf.js")
  fs.writeFileSync(script, "await agent('x')")
  const r = await runOptimizationLoop({
    scriptPath: "wf.js",
    cwd: dir,
    analyze: async (p) => buildReport({ source: fs.readFileSync(p, "utf8"), file: p, generatedAt: "T" }),
    propose: async () => ({ recommendations: [], patchedSource: "await agent('y')" }),
  })
  check("headless 默认拒绝应用", r.applied === false && r.abortedAt === "confirm")
  check("生产脚本未被修改", fs.readFileSync(script, "utf8") === "await agent('x')")
}

// 6) 授权后应用
{
  const dir = tmp()
  const script = path.join(dir, "wf.js")
  fs.writeFileSync(script, "await agent('x')")
  const r = await runOptimizationLoop({
    scriptPath: "wf.js",
    cwd: dir,
    analyze: async (p) => buildReport({ source: fs.readFileSync(p, "utf8"), file: p, generatedAt: "T" }),
    propose: async () => ({ recommendations: [], patchedSource: "await agent('y')" }),
    confirm: async () => true,
  })
  check("授权后应用成功", r.applied === true && /agent\('y'\)/.test(fs.readFileSync(script, "utf8")))
}

const pass = results.every((r) => r.pass)
const outFile = path.join(import.meta.dirname, "..", "..", "dev-docs", "benchmark", "m5-evaluator-benchmark.json")
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), results, allPass: pass }, null, 2))
console.log("== M5 Benchmark ==")
for (const r of results) console.log(`  [${r.pass ? "PASS" : "FAIL"}] ${r.name}${r.detail ? ` (${r.detail})` : ""}`)
console.log(`\n报告：${outFile}`)
process.exit(pass ? 0 : 1)
