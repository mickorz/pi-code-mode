// RunManager 与全局并发闸测试（无 LLM）
import { test } from "node:test"
import assert from "node:assert/strict"
import { RunManager, withGlobalGate } from "../../packages/manager/src/run-manager.js"
import type { AgentAdapter, AgentResult } from "../../packages/adapter/src/types.js"

test("RunManager: 生命周期 register->attach->finish->list/status", () => {
  const rm = new RunManager(4)
  const run = rm.register("run-1", { label: "src:inline" })
  assert.equal(run.status, "running")
  rm.attach("run-1", { id: "run-1:0", label: "a", status: "running" } as any)
  rm.attach("run-1", { id: "run-1:0", label: "a", status: "ok", durationMs: 10 } as any)
  // 同 id 覆盖不重复
  assert.equal(rm.status("run-1")!.agents.length, 1)
  rm.finish("run-1", { status: "completed", resultPreview: '"done"' })
  assert.equal(rm.status("run-1")!.status, "completed")
  const list = rm.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].agents, 1)
})

test("RunManager: externalSignal aborted 联动取消在途 run", () => {
  const rm = new RunManager()
  const ac = new AbortController()
  rm.register("run-2", { externalSignal: ac.signal })
  ac.abort()
  assert.equal(rm.status("run-2")!.controller.signal.aborted, true)
})

test("RunManager: cancel 幂等且未知 id 返回 false", async () => {
  const rm = new RunManager()
  assert.equal(await rm.cancel("nope"), false)
  rm.register("run-3")
  assert.equal(await rm.cancel("run-3"), true)
  assert.equal(rm.status("run-3")!.controller.signal.aborted, true)
})

test("RunManager: 终态保留窗口 recent 上限 20", () => {
  const rm = new RunManager()
  for (let i = 0; i < 25; i++) {
    rm.register(`run-${i}`)
    rm.finish(`run-${i}`, { status: "completed" })
  }
  assert.equal(rm.list().length, 20)
  // 最早的 run-0/run-1... 被挤出（保留的是最近 20 个）
  assert.equal(rm.status("run-0"), null)
  assert.equal(rm.status("run-24")!.status, "completed")
})

test("全局闸: 并发峰值不超过上限", async () => {
  let active = 0
  let peak = 0
  const slowAdapter: AgentAdapter = {
    async execute(): Promise<AgentResult> {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 20))
      active--
      return { status: "ok", output: { type: "text", value: "x" }, sessionId: "s" }
    },
    async cancel() {},
  }
  const gated = withGlobalGate(slowAdapter, new RunManager(3).gate)
  await Promise.all(Array.from({ length: 10 }, () => gated.execute({ prompt: "p" } as any, { executionId: "e", runId: "r" })))
  assert.ok(peak <= 3, `并发峰值 ${peak} 应 <= 3`)
})

test("全局闸: cancel 方法保留（包装不丢 cancel 语义）", async () => {
  const cancelled: string[] = []
  const adapter: AgentAdapter = {
    async execute(): Promise<AgentResult> {
      return { status: "ok", output: { type: "text", value: "x" }, sessionId: "s" }
    },
    async cancel(id) {
      cancelled.push(id)
    },
  }
  const gated = withGlobalGate(adapter, new RunManager(2).gate)
  await gated.cancel("e-1")
  assert.deepEqual(cancelled, ["e-1"])
})
