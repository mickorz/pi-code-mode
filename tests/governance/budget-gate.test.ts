/**
 * M2-T3 契约测试：Budget Gate（硬预算拦截 / 软预算预留 / 降级 Run 级语义）
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import { BudgetGate } from "../../packages/engine/src/governance/budget-gate.js"
import { nextDegradeTarget } from "../../packages/engine/src/governance/policy-state.js"

function gate(over: Partial<ConstructorParameters<typeof BudgetGate>[0]> = {}) {
  return new BudgetGate({
    runId: "r1",
    limits: {},
    activeProfile: "balanced",
    initialPolicy: { mode: "balanced", concurrency: { max: 4 } },
    requiredValidation: true,
    profiles: {
      balanced: { mode: "balanced", concurrency: { max: 4 } },
      fast: { mode: "fast", concurrency: { max: 8 } },
    },
    ...over,
  })
}

test("硬预算 maxAgents：超额拒绝 dispatch（带 violation）", () => {
  const g = gate({ limits: { maxAgents: 1 } })
  assert.equal(g.beforeDispatch("x").allow, true)
  const second = g.beforeDispatch("x")
  assert.equal(second.allow, false)
  assert.equal(second.violation?.kind, "hard-agents")
})

test("软预算正常预留并结算", () => {
  const g = gate({ limits: { maxInputTokens: 100000 } })
  const d = g.beforeDispatch("a".repeat(400))
  assert.equal(d.allow, true)
  assert.ok(d.reservationId)
  g.afterDispatch(d.reservationId, { input: 120, output: 30 }, "ok")
  assert.equal(g.totals().inputTokens, 120)
})

test("软预算不足 → 触发降级（quality→balanced）", () => {
  const g = gate({
    limits: { maxInputTokens: 10 },
    activeProfile: "quality",
    initialPolicy: { mode: "balanced", concurrency: { max: 2 } },
    profiles: { balanced: { mode: "balanced", concurrency: { max: 4 } }, fast: { mode: "fast" } },
  })
  const d = g.beforeDispatch("a".repeat(4000))
  // 预留不成 → 降级一次（quality→balanced），仍不足则拒绝
  assert.equal(d.allow, false)
  assert.equal(d.degraded?.from, "quality")
  assert.equal(d.degraded?.to, "balanced")
  // 降级记录写入 policyTransitions
  assert.equal(g.policyState.history.length, 1)
  assert.equal(g.policyState.activeProfile, "quality", "activeProfile 保持初始值")
  assert.equal(g.policyState.profile, "balanced", "effectiveProfile 已降级")
})

test("降级不关闭强制验证", () => {
  const g = gate({ limits: { maxInputTokens: 1 }, requiredValidation: true })
  g.beforeDispatch("a".repeat(400))
  assert.equal(g.policyState.validationRequired, true)
})

test("降级链：quality→balanced→fast，耗尽后拒绝", () => {
  assert.equal(nextDegradeTarget("quality"), "balanced")
  assert.equal(nextDegradeTarget("balanced"), "fast")
  assert.equal(nextDegradeTarget("fast"), undefined)
})

test("软限超限 → maybeDegradeOnSoftLimit 降级一次并记录原因", () => {
  const g = gate({
    limits: { maxInputTokens: 100 },
    activeProfile: "quality",
    initialPolicy: { mode: "balanced" },
    profiles: { balanced: { mode: "balanced" }, fast: { mode: "fast" } },
  })
  g.tracker.recordUsage({ input: 500 })
  const deg = g.maybeDegradeOnSoftLimit()
  assert.equal(deg?.to, "balanced")
  assert.match(g.policyState.history[0]!.reason, /超软限/)
  // 已降级到 balanced，再次调用可继续降 fast
  const deg2 = g.maybeDegradeOnSoftLimit()
  assert.equal(deg2?.to, "fast")
  // fast 之后不再降
  assert.equal(g.maybeDegradeOnSoftLimit(), undefined)
})

test("toRunConfig：activeProfile/effectivePolicy/policyTransitions 齐全", () => {
  const g = gate({ limits: { maxInputTokens: 1 }, activeProfile: "quality", initialPolicy: { mode: "balanced" }, profiles: { balanced: {} } })
  g.beforeDispatch("a".repeat(100))
  const cfg = g.policyState.toRunConfig({ workflowId: "wf", planHash: "sha256:x" })
  assert.equal(cfg.activeProfile, "quality")
  assert.equal(cfg.runId, "r1")
  assert.equal(cfg.workflowId, "wf")
  assert.ok(Array.isArray(cfg.policyTransitions))
  assert.ok(cfg.effectivePolicy)
})

test("remaining()：脚本可查询余量", () => {
  const g = gate({ limits: { maxInputTokens: 10000, maxAgents: 3 } })
  g.beforeDispatch("a".repeat(400))
  const rem = g.remaining()
  assert.ok((rem.inputTokens ?? 0) < 10000)
  assert.equal(rem.agents, 2)
})

test("取消的 dispatch 释放预留（不计消耗）", () => {
  const g = gate({ limits: { maxInputTokens: 1000 } })
  const d = g.beforeDispatch("a".repeat(400))
  g.afterDispatch(d.reservationId, undefined, "cancelled")
  assert.equal(g.totals().inputTokens, 0)
})
