/** M6/2：parallel() 自动任务化接 BatchExecutor（跨 run 复用） */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { runWorkflow } from "../../src/engine/runtime/workflow-runtime.js"
import { TaskRegistry } from "../../src/engine/governance/task-registry.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m6-shard-"))
const runner = (state: { calls: number }): any => ({
  async run() { state.calls++; return { type: "text", value: "ok", sessionId: `s${state.calls}` } },
  async cancel() {},
})

function script(n: number) {
  return `export const meta = { name: 'auto_shard' }
const rs = await parallel([${Array.from({ length: n }, (_, i) => `() => agent('t${i}')`).join(",")}])
return rs.length`
}

test("任务数达阈值 + taskRegistry：自动走 BatchExecutor 并在第二次 run 全部复用", async () => {
  const cwd = tmp()
  const state = { calls: 0 }
  const reg = new TaskRegistry({ dir: path.join(cwd, ".pi", "workflows", "tasks"), workflowId: "auto_shard" })
  const a = await runWorkflow(script(10), { agent: runner(state), cwd, runId: "r1", taskRegistry: reg, taskResume: true, autoShardThreshold: 8 })
  assert.equal(a.result, 10, "返回顺序与数量不变")
  assert.equal(state.calls, 10)

  const b = await runWorkflow(script(10), { agent: runner(state), cwd, runId: "r2", taskRegistry: reg, taskResume: true, autoShardThreshold: 8 })
  assert.equal(b.result, 10)
  assert.equal(state.calls, 10, "第二次应全部复用，不调用 agent")
})

test("任务数低于阈值：走原 Promise.all 路径（不落任务清单）", async () => {
  const cwd = tmp()
  const state = { calls: 0 }
  const reg = new TaskRegistry({ dir: path.join(cwd, ".pi", "workflows", "tasks"), workflowId: "small_shard" })
  const scriptSmall = `export const meta = { name: 'small_shard' }
const rs = await parallel([() => agent('a'), () => agent('b')])
return rs.length`
  await runWorkflow(scriptSmall, { agent: runner(state), cwd, runId: "r1", taskRegistry: reg, taskResume: true, autoShardThreshold: 8 })
  assert.equal(state.calls, 2)
  assert.equal(reg.list().filter((t) => t.taskKey.startsWith("p:")).length, 0, "不应产生 parallel 任务")
})

test("自动任务化保留失败塌缩语义（可恢复失败 → null，不中断）", async () => {
  const cwd = tmp()
  let calls = 0
  const flaky: any = {
    async run() {
      calls++
      if (calls === 3) throw new Error("recoverable boom")
      return { type: "text", value: "ok", sessionId: `s${calls}` }
    },
    async cancel() {},
  }
  const reg = new TaskRegistry({ dir: path.join(cwd, ".pi", "workflows", "tasks"), workflowId: "flaky_shard" })
  const r = await runWorkflow(script(10), { agent: flaky, cwd, runId: "r1", taskRegistry: reg, taskResume: false, autoShardThreshold: 8 })
  assert.equal(r.result, 10)
  assert.equal(fs.existsSync(path.join(cwd, ".pi", "workflows", "tasks")), true)
})
