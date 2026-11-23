/**
 * O2 真实 Benchmark 适配器契约（2026-11-23）
 *
 * 重点验证「不虚构」与「质量门不可绕过」：
 *  - 没 verifier / Required Validation → quality=unavailable → accepted=false
 *  - after 失败 / 失败 Agent 增加 / 产物 hash 不一致 → accepted=false
 *  - 无 >=5% 改善 → accepted=false
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import { renderBenchmarkVerdict, runRealBenchmark, toBenchmarkMetrics, type RealRunOutcome } from "../../src/engine/optimizer/benchmark-adapter.js"

function outcome(over: Partial<RealRunOutcome> = {}): RealRunOutcome {
  return { ok: true, durationMs: 100_000, agents: 10, inputTokens: 50_000, outputTokens: 8000, failedAgents: 0, ...over }
}

function runOf(before: RealRunOutcome, after: RealRunOutcome) {
  return async ({ label }: { label: "before" | "after" }) => (label === "before" ? before : after)
}

const VERIFIER_PASS = { kind: "verifier" as const, command: "npm test" }
const runVerifierOk = async () => ({ ok: true })
const runVerifierFail = async () => ({ ok: false, output: "1 test failed" })

test("accepted：有改善 + verifier 通过 + 无质量降级", async () => {
  const v = await runRealBenchmark({
    scriptPath: "wf.js",
    cwd: "/x",
    run: runOf(outcome(), outcome({ durationMs: 60_000, inputTokens: 30_000 })),
    qualityGate: VERIFIER_PASS,
    runVerifier: runVerifierOk,
  })
  assert.equal(v.accepted, true, v.reasons.join("; "))
  assert.equal(v.hasGain, true)
  assert.equal(v.quality.status, "pass")
  const dur = v.comparisons.find((c) => c.metric === "durationMs")!
  assert.equal(Math.round(dur.improvement! * 100), 40)
})

test("rejected：没有 verifier → 质量门不可用（禁止凭「变快」放行）", async () => {
  const v = await runRealBenchmark({
    scriptPath: "wf.js",
    cwd: "/x",
    run: runOf(outcome(), outcome({ durationMs: 50_000 })),
    qualityGate: { kind: "none" },
  })
  assert.equal(v.accepted, false)
  assert.equal(v.quality.status, "unavailable")
  assert.ok(v.reasons.some((r) => /质量门不可用/.test(r)))
})

test("rejected：Plan Required Validation 但无 verifier → unavailable", async () => {
  const v = await runRealBenchmark({
    scriptPath: "wf.js",
    cwd: "/x",
    run: runOf(outcome(), outcome({ durationMs: 50_000 })),
    qualityGate: { kind: "plan", requiredValidation: ["产物 schema 不变"] },
  })
  assert.equal(v.accepted, false)
  assert.equal(v.quality.status, "unavailable")
})

test("rejected：verifier 失败", async () => {
  const v = await runRealBenchmark({
    scriptPath: "wf.js",
    cwd: "/x",
    run: runOf(outcome(), outcome({ durationMs: 50_000 })),
    qualityGate: VERIFIER_PASS,
    runVerifier: runVerifierFail,
  })
  assert.equal(v.accepted, false)
  assert.equal(v.quality.status, "fail")
})

test("rejected：after 执行失败", async () => {
  const v = await runRealBenchmark({
    scriptPath: "wf.js",
    cwd: "/x",
    run: runOf(outcome(), outcome({ ok: false, durationMs: 50_000, error: "boom" })),
    qualityGate: VERIFIER_PASS,
    runVerifier: runVerifierOk,
  })
  assert.equal(v.accepted, false)
  assert.ok(v.reasons.some((r) => /after 执行失败/.test(r)))
})

test("rejected：失败 Agent 增加", async () => {
  const v = await runRealBenchmark({
    scriptPath: "wf.js",
    cwd: "/x",
    run: runOf(outcome(), outcome({ durationMs: 50_000, failedAgents: 3 })),
    qualityGate: VERIFIER_PASS,
    runVerifier: runVerifierOk,
  })
  assert.equal(v.accepted, false)
  assert.ok(v.reasons.some((r) => /失败 Agent 增加/.test(r)))
})

test("rejected：产物 hash 不一致（行为改变）", async () => {
  const v = await runRealBenchmark({
    scriptPath: "wf.js",
    cwd: "/x",
    run: runOf(
      outcome({ artifacts: { "out.json": "sha256:aaa" } }),
      outcome({ durationMs: 50_000, artifacts: { "out.json": "sha256:bbb" } }),
    ),
    qualityGate: VERIFIER_PASS,
    runVerifier: runVerifierOk,
  })
  assert.equal(v.accepted, false)
  assert.equal(v.quality.artifactsIdentical, false)
})

test("rejected：改善不足 5%", async () => {
  const v = await runRealBenchmark({
    scriptPath: "wf.js",
    cwd: "/x",
    run: runOf(outcome(), outcome({ durationMs: 98_000 })),
    qualityGate: VERIFIER_PASS,
    runVerifier: runVerifierOk,
  })
  assert.equal(v.accepted, false)
  assert.equal(v.hasGain, false)
  assert.ok(v.reasons.some((r) => /改善 ≥ 5%/.test(r)))
})

test("toBenchmarkMetrics：真实结果转 runner 指标", () => {
  const m = toBenchmarkMetrics(outcome({ failedAgents: 1 }))
  assert.equal(m.durationMs, 100_000)
  assert.equal(m.agents, 10)
  assert.equal(m.inputTokens, 50_000)
  assert.equal(m.failedAgents, 1)
  assert.equal(m.ok, true)
})

test("renderBenchmarkVerdict：包含结论/质量门/指标表/原因", async () => {
  const v = await runRealBenchmark({
    scriptPath: "wf.js",
    cwd: "/x",
    run: runOf(outcome(), outcome({ durationMs: 60_000 })),
    qualityGate: { kind: "none" },
  })
  const md = renderBenchmarkVerdict(v)
  assert.match(md, /未通过/)
  assert.match(md, /质量门：unavailable/)
  assert.match(md, /\| durationMs \|/)
  assert.match(md, /未通过原因/)
})
