/**
 * M5-T1/T2 契约测试：Evaluator + BaselineStore
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { evaluate, renderEvaluation } from "../../src/engine/evaluator/evaluator.js"
import { BaselineStore } from "../../src/engine/evaluator/baseline-store.js"
import type { WorkflowPlan } from "../../src/engine/plan/schema.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m5-eval-"))

function plan(): WorkflowPlan {
  return {
    planVersion: "1.0",
    workflowId: "wf",
    planHash: "sha256:plan",
    source: { scriptHash: "sha256:script" },
    definition: {
      stages: [
        { id: "scan", type: "parallel", estimatedAgents: 8, estimatedInputTokens: 50000 },
        { id: "review", type: "parallel", estimatedAgents: 8 },
        { id: "summary", type: "sequential", estimatedAgents: 1 },
      ],
      quality: { requiredValidation: true },
    },
    profiles: { balanced: {} },
  } as WorkflowPlan
}

test("evaluate：按 stage 计算偏差率", () => {
  const r = evaluate({
    plan: plan(),
    runId: "run1",
    actuals: [
      { stageId: "scan", agents: 8, inputTokens: 60000, durationMs: 100000 },
      { stageId: "review", agents: 10, durationMs: 200000 },
      { stageId: "summary", agents: 1, durationMs: 10000 },
    ],
  })
  assert.equal(r.summary.estimatedAgents, 17)
  assert.equal(r.summary.actualAgents, 19)
  assert.ok(Math.abs(r.summary.agentDeviation! - (19 - 17) / 17) < 1e-9)
  const scan = r.stages.find((s) => s.stageId === "scan")!
  assert.equal(scan.tokenDeviation, (60000 - 50000) / 50000)
  const review = r.stages.find((s) => s.stageId === "review")!
  assert.equal(review.over, true, "10 vs 8 偏差 25% > 20% 应标超阈")
})

test("evaluate：缺预估的 stage 记入 missingEstimate（不编造偏差）", () => {
  const r = evaluate({ plan: plan(), runId: "r", actuals: [{ stageId: "unplanned", agents: 3 }] })
  assert.deepEqual(r.missingEstimate, ["unplanned"])
  const s = r.stages.find((x) => x.stageId === "unplanned")!
  assert.equal(s.agentDeviation, undefined, "无预估不得给出偏差")
})

test("evaluate：超预算项被记录", () => {
  const r = evaluate({
    plan: plan(),
    runId: "r",
    actuals: [{ stageId: "scan", agents: 30, inputTokens: 999999 }],
    budget: { maxAgents: 20, maxInputTokens: 100000 },
  })
  assert.equal(r.summary.overBudget.length, 2)
})

test("evaluate：无 Plan 也能评估实际值（预估全 0）", () => {
  const r = evaluate({ runId: "r", actuals: [{ stageId: "s", agents: 5, durationMs: 1000 }] })
  assert.equal(r.summary.actualAgents, 5)
  assert.equal(r.summary.estimatedAgents, 0)
  assert.equal(r.summary.agentDeviation, undefined)
})

test("renderEvaluation：Markdown 含偏差与超阈标记", () => {
  const r = evaluate({
    plan: plan(),
    runId: "run1",
    inputScale: "48-requirements",
    actuals: [{ stageId: "scan", agents: 12, inputTokens: 80000 }],
  })
  const md = renderEvaluation(r)
  assert.match(md, /输入规模标记：48-requirements/)
  assert.match(md, /偏差仅在同规模下可比/)
  assert.match(md, /\| scan \|/)
})

test("BaselineStore：记录样本并计算 P50/P90", () => {
  const store = new BaselineStore({ dir: tmp() })
  for (const [i, dur] of [1000, 2000, 3000, 10000].entries()) {
    store.record({
      workflowId: "wf",
      scriptHash: "sha256:s1",
      report: evaluate({ plan: plan(), runId: `r${i}`, actuals: [{ stageId: "scan", agents: 8, inputTokens: 1000, durationMs: dur }] }),
    })
  }
  const series = store.get("wf", "sha256:s1")!
  assert.equal(series.samples.length, 4)
  assert.equal(series.stats.durationMs.max, 10000)
  assert.ok(series.stats.durationMs.p50 >= 2000)
})

test("BaselineStore：样本不足不做回归判定（防误报）", () => {
  const store = new BaselineStore({ dir: tmp(), minSamples: 3 })
  store.record({ workflowId: "wf", scriptHash: "sha256:s", report: evaluate({ runId: "r1", actuals: [{ stageId: "s", agents: 1, durationMs: 100 }] }) })
  const v = store.detectRegression({ workflowId: "wf", scriptHash: "sha256:s", actual: { agents: 1, durationMs: 99999, inputTokens: 0 } })
  assert.equal(v.comparable, false)
  assert.equal(v.regressed, false)
})

test("BaselineStore：显著劣化 → 检出回归（含百分比信号）", () => {
  const dir = tmp()
  const store = new BaselineStore({ dir, minSamples: 3, tolerance: 0.3 })
  for (let i = 0; i < 4; i++) {
    store.record({
      workflowId: "wf",
      scriptHash: "sha256:s",
      report: evaluate({ runId: `r${i}`, actuals: [{ stageId: "s", agents: 4, inputTokens: 1000, durationMs: 1000 }] }),
    })
  }
  const ok = store.detectRegression({ workflowId: "wf", scriptHash: "sha256:s", actual: { agents: 4, durationMs: 1100, inputTokens: 1000 } })
  assert.equal(ok.regressed, false, "小幅波动不算回归")

  const bad = store.detectRegression({ workflowId: "wf", scriptHash: "sha256:s", actual: { agents: 4, durationMs: 5000, inputTokens: 1000 } })
  assert.equal(bad.regressed, true)
  assert.ok(bad.signals.some((s) => s.metric === "durationMs" && s.ratio > 4))
})

test("BaselineStore：同 workflowId 不同 scriptHash 分开存储（版本隔离）", () => {
  const dir = tmp()
  const store = new BaselineStore({ dir })
  store.record({ workflowId: "wf", scriptHash: "sha256:v1", report: evaluate({ runId: "r1", actuals: [{ stageId: "s", agents: 1, durationMs: 100 }] }) })
  store.record({ workflowId: "wf", scriptHash: "sha256:v2", report: evaluate({ runId: "r2", actuals: [{ stageId: "s", agents: 2, durationMs: 200 }] }) })
  assert.equal(store.list().length, 2)
  assert.equal(store.get("wf", "sha256:v1")!.samples.length, 1)
})

test("BaselineStore：按输入规模过滤比较（跨规模不可比）", () => {
  const dir = tmp()
  const store = new BaselineStore({ dir, minSamples: 2, tolerance: 0.3 })
  for (let i = 0; i < 3; i++) {
    store.record({
      workflowId: "wf",
      scriptHash: "sha256:s",
      report: evaluate({ runId: `small${i}`, inputScale: "12-items", actuals: [{ stageId: "s", agents: 2, inputTokens: 100, durationMs: 100 }] }),
    })
  }
  // 大规模型号样本不足 → 与大规模比较应不可判定
  const v = store.detectRegression({ workflowId: "wf", scriptHash: "sha256:s", inputScale: "48-items", actual: { agents: 8, durationMs: 400, inputTokens: 400 } })
  assert.equal(v.comparable, false, "跨规模不得直接比较")
})

test("BaselineStore：trend 返回最近 N 次序列", () => {
  const store = new BaselineStore({ dir: tmp() })
  for (const d of [100, 200, 300]) {
    store.record({ workflowId: "wf", scriptHash: "sha256:s", report: evaluate({ runId: `r${d}`, actuals: [{ stageId: "s", agents: 1, durationMs: d }] }) })
  }
  assert.deepEqual(store.trend("wf", "sha256:s", "durationMs"), [100, 200, 300])
})

test("BaselineStore：无基线时回归检测返回 comparable=false", () => {
  const store = new BaselineStore({ dir: tmp() })
  const v = store.detectRegression({ workflowId: "none", scriptHash: "sha256:x", actual: { agents: 1, durationMs: 1, inputTokens: 1 } })
  assert.equal(v.comparable, false)
  assert.match(v.reason!, /无历史基线/)
})
