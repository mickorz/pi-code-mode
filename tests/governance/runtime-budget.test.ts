/**
 * M2 集成契约测试：runtime 接入预算闸 + budget.remaining() 脚本 API
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { BudgetGate } from "../../src/engine/governance/budget-gate.js"
import { runWorkflow } from "../../src/engine/runtime/workflow-runtime.js"
import type { AgentSessionRunner } from "../../src/engine/agent/session-runner.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m2-budget-"))

function countingRunner(): { runner: AgentSessionRunner; state: { calls: number } } {
  const state = { calls: 0 }
  return {
    state,
    runner: {
      async run(prompt) {
        state.calls++
        return { type: "text", value: `ok:${prompt.slice(0, 10)}`, sessionId: `s-${state.calls}` }
      },
      async cancel() {},
    },
  }
}

function makeGate(over: Partial<ConstructorParameters<typeof BudgetGate>[0]> = {}) {
  return new BudgetGate({
    runId: "run-m2",
    limits: {},
    activeProfile: "balanced",
    initialPolicy: { mode: "balanced" },
    requiredValidation: true,
    profiles: { balanced: { mode: "balanced" }, fast: { mode: "fast" } },
    ...over,
  })
}

test("硬预算 maxAgents：runtime 侧拦截并终止（不可恢复）", async () => {
  const gate = makeGate({ limits: { maxAgents: 1 } })
  const { runner } = countingRunner()
  const script = `export const meta = { name: 'm2_hard' }
await agent('a')
await agent('b')
return 'done'`
  await assert.rejects(
    runWorkflow(script, { agent: runner, cwd: tmp(), budgetGate: gate, agentRetries: 0 }),
    /预算拦截|agent 数已达上限/,
  )
})

test("未注入 budgetGate：行为与旧版完全一致（零改动兼容）", async () => {
  const counted = countingRunner()
  const script = `export const meta = { name: 'm2_compat' }
await agent('a')
await agent('b')
return 'done'`
  const r = await runWorkflow(script, { agent: counted.runner, cwd: tmp() })
  assert.equal(r.result, "done")
  assert.equal(counted.state.calls, 2)
})

test("软预算预留与结算：真实 usage 记账", async () => {
  const gate = makeGate({ limits: { maxInputTokens: 100000 } })
  const { runner } = countingRunner()
  const script = `export const meta = { name: 'm2_soft' }
const usage = await agent('x')
const rem = budget.remaining()
return { usage, rem }`
  const r = await runWorkflow(script, {
    agent: runner,
    cwd: tmp(),
    budgetGate: gate,
    onAgentJournal: () => {},
  })
  const out = r.result as { usage: unknown; rem: { inputTokens?: number } }
  assert.ok(out.rem)
  assert.ok(typeof out.rem.inputTokens === "number", "budget.remaining() 应返回余量")
  const totals = gate.totals()
  assert.equal(totals.agents, 1, "dispatch 计数")
  assert.ok(totals.inputTokens > 0, "结算后应有 input 记账")
})

test("budget.remaining()：未注入预算闸时返回空对象（脚本不报错）", async () => {
  const { runner } = countingRunner()
  const script = `export const meta = { name: 'm2_nobudget' }
const rem = budget.remaining()
const totals = budget.totals()
await agent('x')
return { rem, totals }`
  const r = await runWorkflow(script, { agent: runner, cwd: tmp() })
  const out = r.result as { rem: Record<string, unknown>; totals: { agents: number } }
  assert.deepEqual(out.rem, {})
  assert.equal(out.totals.agents, 0)
})

test("失败 attempt 释放预留（不计消耗）", async () => {
  const gate = makeGate({ limits: { maxInputTokens: 1000 } })
  const runner: AgentSessionRunner = {
    async run() {
      throw new Error("boom")
    },
    async cancel() {},
  }
  const script = `export const meta = { name: 'm2_fail' }
await agent('x')
return 'unreachable'`
  await assert.rejects(runWorkflow(script, { agent: runner, cwd: tmp(), budgetGate: gate, agentRetries: 0 }))
  const snap = gate.tracker.snapshot()
  assert.equal(snap.reservedInput, 0, "失败后预留应释放")
})

test("降级写入 run 日志（policyTransitions 可追溯）", async () => {
  const gate = makeGate({
    limits: { maxInputTokens: 1 },
    activeProfile: "quality",
    initialPolicy: { mode: "balanced" },
    profiles: { balanced: { mode: "balanced" }, fast: { mode: "fast" } },
  })
  const { runner } = countingRunner()
  const script = `export const meta = { name: 'm2_degrade' }
await agent('a'.repeat(200))
return 'done'`
  await assert.rejects(runWorkflow(script, { agent: runner, cwd: tmp(), budgetGate: gate, agentRetries: 0 }))
  assert.ok(gate.policyState.history.length >= 1, "应记录降级")
  assert.equal(gate.policyState.activeProfile, "quality")
})
