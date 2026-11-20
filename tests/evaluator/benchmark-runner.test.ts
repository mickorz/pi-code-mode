/** M6/4 契约测试：真实 Benchmark 执行器（质量不降级 + 不虚构收益） */
import assert from "node:assert/strict"
import { test } from "node:test"

import { renderBenchmark, requiredValidationOf, runBenchmark, validationSatisfied } from "../../src/engine/evaluator/benchmark-runner.js"
import type { WorkflowPlan } from "../../src/engine/plan/schema.js"

function plan(over: Partial<any> = {}): WorkflowPlan {
  return {
    planVersion: "1.0",
    workflowId: "bench_wf",
    source: { scriptHash: "sha256:x" },
    definition: {
      stages: [{ id: "s", type: "sequential" }],
      quality: { requiredValidation: true, acceptanceCriteria: ["需求覆盖", "结算规则"] },
    },
    profiles: { fast: {}, balanced: {}, quality: { additionalValidation: ["交叉评审"] } },
    ...over,
  } as WorkflowPlan
}

test("validationSatisfied：全部通过=yes / 缺失或失败=no / 无验证=unknown", () => {
  const req = ["a", "b"]
  assert.equal(validationSatisfied(req, { passed: ["a", "b"], failed: [] }).status, "yes")
  assert.equal(validationSatisfied(req, { passed: ["a"], failed: [] }).status, "no")
  assert.equal(validationSatisfied(req, { passed: ["a"], failed: ["b"] }).status, "no")
  assert.equal(validationSatisfied(req, undefined).status, "unknown")
})

test("requiredValidationOf：提取 Definition 强制项，Profile 削弱可检出", () => {
  assert.deepEqual(requiredValidationOf(plan(), "fast").required, ["需求覆盖", "结算规则"])
  assert.equal(requiredValidationOf(plan(), "fast").weakened, false)
})

test("benchmark：真实改善 + 质量未降级 → 通过", async () => {
  const r = await runBenchmark({
    plan: plan(),
    mode: "balanced",
    runOnce: async (label) =>
      label === "before"
        ? { durationMs: 10_000, inputTokens: 100_000, agents: 8, failedAgents: 1, ok: true, validation: { passed: ["需求覆盖", "结算规则"], failed: [] } }
        : { durationMs: 6_000, inputTokens: 60_000, agents: 8, failedAgents: 0, ok: true, validation: { passed: ["需求覆盖", "结算规则"], failed: [] } },
  })
  assert.equal(r.accepted, true)
  assert.equal(r.quality.requiredValidationSatisfied, "yes")
  assert.equal(r.quality.degraded, false)
  const dur = r.comparisons.find((c) => c.metric === "durationMs")!
  assert.ok(Math.abs(dur.improvement! - 0.4) < 1e-9, "改善率应来自真实测量（40%）")
})

test("benchmark：变快但 Required Validation 失败 → 不通过（质量优先）", async () => {
  const r = await runBenchmark({
    plan: plan(),
    runOnce: async (label) =>
      label === "before"
        ? { durationMs: 10_000, ok: true, validation: { passed: ["需求覆盖", "结算规则"], failed: [] } }
        : { durationMs: 3_000, ok: true, validation: { passed: ["需求覆盖"], failed: ["结算规则"] } },
  })
  assert.equal(r.accepted, false, "质量不达标不得通过")
  assert.equal(r.quality.degraded, true)
  assert.ok(r.quality.reasons.some((x) => /Required Validation/.test(x)))
})

test("benchmark：after 执行失败 → 不通过", async () => {
  const r = await runBenchmark({
    runOnce: async (label) =>
      label === "before" ? { durationMs: 5_000, ok: true } : { durationMs: 1_000, ok: false, error: "boom" },
  })
  assert.equal(r.accepted, false)
  assert.equal(r.quality.degraded, true)
})

test("benchmark：无改善（<5%）→ 不通过，且不虚构收益", async () => {
  const r = await runBenchmark({
    runOnce: async () => ({ durationMs: 5_000, ok: true }),
  })
  assert.equal(r.accepted, false)
  assert.ok(r.notes.some((n) => /未测得 ≥5%/.test(n)))
})

test("benchmark：失败 Agent 增加 → 判降级", async () => {
  const r = await runBenchmark({
    runOnce: async (label) =>
      label === "before"
        ? { durationMs: 10_000, failedAgents: 0, ok: true }
        : { durationMs: 5_000, failedAgents: 3, ok: true },
  })
  assert.equal(r.quality.degraded, true)
  assert.equal(r.accepted, false)
})

test("renderBenchmark：Markdown 含结论/对比/质量原因", async () => {
  const r = await runBenchmark({
    plan: plan(),
    mode: "balanced",
    runOnce: async (label) => (label === "before" ? { durationMs: 10_000, ok: true } : { durationMs: 4_000, ok: true }),
  })
  const md = renderBenchmark(r)
  assert.match(md, /# Benchmark 结果/)
  assert.match(md, /\| durationMs \|/)
  assert.match(md, /Required Validation/)
})
