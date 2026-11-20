/**
 * M2-T1/T2/T2b 契约测试：预算三分类 + Reservation 原子性（五条约束）
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import { BudgetTracker, estimateTokens, limitsFromPolicy } from "../../src/engine/governance/budget-tracker.js"

test("硬预算 maxAgents：dispatch 前拦截（总 dispatch 次数语义）", () => {
  const b = new BudgetTracker({ runId: "r", limits: { maxAgents: 2 } })
  assert.equal(b.canDispatch(), null)
  b.recordDispatch()
  b.recordDispatch()
  const v = b.canDispatch()
  assert.ok(v)
  assert.equal(v!.kind, "hard-agents")
  assert.equal(v!.action, "block")
})

test("硬预算 maxDurationMs：超时 stop", () => {
  const b = new BudgetTracker({ runId: "r", limits: { maxDurationMs: 1000 }, startedAt: 0 })
  assert.equal(b.canDispatch(500), null)
  assert.equal(b.canDispatch(1500)?.action, "stop")
})

test("硬预算 maxRetries：累计上限", () => {
  const b = new BudgetTracker({ runId: "r", limits: { maxRetries: 1 } })
  assert.equal(b.recordRetry(), null, "第 1 次重试允许（maxRetries=1）")
  assert.equal(b.recordRetry()?.kind, "hard-retries", "第 2 次重试超限")
})

test("软预算预留原子性：并发不重复消费同一余额（约束①②）", () => {
  const b = new BudgetTracker({ runId: "r", limits: { maxInputTokens: 10000 } })
  const ok = [1, 2, 3, 4].map(() => b.reserve({ estimatedInputTokens: 3000, estimatedOutputTokens: 0 }))
  assert.equal(ok.filter(Boolean).length, 3, "第 4 个必须被拒（余额仅剩 1000）")
  assert.equal(b.snapshot().reservedInput, 9000)
})

test("结算：真实 usage 覆盖预留（约束④）", () => {
  const b = new BudgetTracker({ runId: "r", limits: { maxInputTokens: 10000 } })
  const r = b.reserve({ estimatedInputTokens: 5000 })!
  const { estimateOnly } = b.settle(r.reservationId, { input: 1200, output: 300 })
  assert.equal(estimateOnly, false)
  const snap = b.snapshot()
  assert.equal(snap.inputTokens.used, 1200)
  assert.equal(snap.reservedInput, 0)
})

test("失败且无 usage → 释放预留不计消耗（约束③）", () => {
  const b = new BudgetTracker({ runId: "r", limits: { maxInputTokens: 1000 } })
  const r = b.reserve({ estimatedInputTokens: 800 })!
  b.settle(r.reservationId, undefined, "failed")
  assert.equal(b.snapshot().inputTokens.used, 0)
  assert.equal(b.snapshot().reservedInput, 0)
})

test("无真实 usage → 标记估算不伪装精确（约束⑤）", () => {
  const b = new BudgetTracker({ runId: "r", limits: { maxInputTokens: 10000 } })
  const r = b.reserve({ estimatedInputTokens: 4000 })!
  assert.equal(b.settle(r.reservationId, undefined, "ok").estimateOnly, true)
  assert.equal(b.totals().estimated, true)
})

test("显式 release：取消场景归还预留", () => {
  const b = new BudgetTracker({ runId: "r", limits: { maxInputTokens: 1000 } })
  const r = b.reserve({ estimatedInputTokens: 1000 })!
  assert.equal(b.reserve({ estimatedInputTokens: 1 }), null)
  assert.equal(b.release(r.reservationId), true)
  assert.ok(b.reserve({ estimatedInputTokens: 1000 }))
})

test("软限超限检查：返回 degrade 动作", () => {
  const b = new BudgetTracker({ runId: "r", limits: { maxInputTokens: 100 } })
  b.recordUsage({ input: 150 })
  const v = b.checkSoftLimits()
  assert.equal(v?.kind, "soft-input")
  assert.equal(v?.action, "degrade")
})

test("remaining()：脚本可见余量（含预留占用）", () => {
  const b = new BudgetTracker({ runId: "r", limits: { maxInputTokens: 1000, maxAgents: 5 } })
  b.reserve({ estimatedInputTokens: 400 })
  b.recordDispatch()
  const rem = b.remaining()
  assert.equal(rem.inputTokens, 600)
  assert.equal(rem.agents, 4)
  assert.equal(rem.estimated, false)
})

test("estimateTokens：约 4 字符/token", () => {
  assert.equal(estimateTokens("1234"), 1)
  assert.equal(estimateTokens("12345"), 2)
})

test("limitsFromPolicy：从 Plan Profile 取预算", () => {
  assert.deepEqual(limitsFromPolicy({ budget: { maxAgents: 3 } }), { maxAgents: 3 })
  assert.deepEqual(limitsFromPolicy(undefined), {})
})

test("totals()：聚合与预留统计", () => {
  const b = new BudgetTracker({ runId: "r" })
  b.recordDispatch()
  b.recordUsage({ input: 10, output: 20 })
  const t = b.totals()
  assert.equal(t.agents, 1)
  assert.equal(t.inputTokens, 10)
  assert.equal(t.outputTokens, 20)
})
