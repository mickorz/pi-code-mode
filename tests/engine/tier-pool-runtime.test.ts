// tier 池接入 runtime 契约：acquire 决定 model / 满载串行化 / 释放 / 显式 model 优先（无模型）
import test from "node:test"
import assert from "node:assert/strict"
import { runWorkflow } from "../../packages/engine/src/runtime/workflow-runtime.js"
import { ModelPool } from "../../packages/engine/src/agent/model-pool.js"
import type { AgentSessionRunner, AgentRunOptions } from "../../packages/engine/src/agent/session-runner.js"
import { textResult } from "./helpers.js"

/** 记录 model 分派与在途数的 fake runner（armAt 指定索引挂起，releaseIdx 放行） */
function trackingAgent(armAt: number[] = []) {
  const armed = new Set(armAt)
  const calls: Array<{ model?: string; finished: boolean }> = []
  let active = 0
  let maxActive = 0
  const resolvers: Array<() => void> = []
  const runner: AgentSessionRunner = {
    async run(_prompt, options: AgentRunOptions | undefined) {
      const idx = calls.length
      calls.push({ model: options?.model, finished: false })
      active++
      maxActive = Math.max(maxActive, active)
      if (armed.has(idx)) await new Promise<void>((r) => resolvers.push(r))
      calls[idx].finished = true
      active--
      return textResult(`echo:${idx}`, `sess-${idx}`)
    },
  }
  return {
    runner,
    calls,
    get maxActive() {
      return maxActive
    },
    releaseIdx(idx: number) {
      resolvers[idx]?.()
    },
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("runtime 池: acquire 决定 record.model", async () => {
  const pool = new ModelPool([{ model: "prov/a", concurrency: 16 }, { model: "prov/b", concurrency: 8 }])
  const t = trackingAgent()
  const outcome = await runWorkflow(
    `export const meta = { name: "t" }
const [x, y, z] = await parallel([() => agent("p1", { tier: "fast" }), () => agent("p2", { tier: "fast" }), () => agent("p3", { tier: "fast" })])
return { x, y, z }`,
    {
      agent: t.runner,
      resolveTierPool: (tier) => (tier === "fast" ? pool : undefined),
    },
  )
  assert.equal(t.calls.length, 3)
  // 无并发竞争时剩余产能最大者（a）恒被选中
  assert.ok(t.calls.every((c) => c.model === "prov/a"))
  assert.ok(outcome.agents.every((a) => a.model === "prov/a"))
})

test("runtime 池: 满载串行化（limit 1 时两 agent 排队）", async () => {
  const pool = new ModelPool([{ model: "prov/solo", concurrency: 1 }])
  const t = trackingAgent([0]) // 第一个 agent 挂起占池槽
  const p = runWorkflow(
    `export const meta = { name: "t" }
const [x, y] = await parallel([() => agent("p1", { tier: "fast" }), () => agent("p2", { tier: "fast" })])
return { x, y }`,
    { agent: t.runner, resolveTierPool: (tier) => (tier === "fast" ? pool : undefined) },
  )
  await wait(80)
  assert.equal(t.calls.length, 1) // 第二个 agent 挂在池上未进 runner
  assert.equal(t.calls[0].model, "prov/solo")
  t.releaseIdx(0) // 放行第一个 → 池释放 → 第二个获得槽位
  await p
  assert.equal(t.calls.length, 2)
  assert.equal(t.calls[1].model, "prov/solo")
  assert.equal(t.maxActive, 1) // 池 limit 1 强制串行
})

test("runtime 池: 显式 model 优先于池（不 acquire）", async () => {
  const pool = new ModelPool([{ model: "prov/pool-model" }])
  const t = trackingAgent()
  await runWorkflow(
    `export const meta = { name: "t" }
return await agent("p1", { model: "prov/explicit" })`,
    { agent: t.runner, resolveTierPool: () => pool },
  )
  assert.equal(t.calls[0].model, "prov/explicit")
  assert.equal(pool.snapshotInflight()[0].inflight, 0) // 未占池槽
})

test("runtime: 无池时 resolveTier 字符串路径保持兼容", async () => {
  const t = trackingAgent()
  await runWorkflow(
    `export const meta = { name: "t" }
return await agent("p1", { tier: "fast" })`,
    { agent: t.runner, resolveTier: (tier) => (tier === "fast" ? "prov/legacy-fast" : undefined) },
  )
  assert.equal(t.calls[0].model, "prov/legacy-fast")
})
