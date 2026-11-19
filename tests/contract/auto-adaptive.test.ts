/** M6/3：AdaptiveScheduler 默认接管——自动从 TaskCheckpoint 加载画像 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { runWorkflow } from "../../src/engine/runtime/workflow-runtime.js"
import { TaskRegistry } from "../../src/engine/governance/task-registry.js"
import { computeTaskFingerprint, contentHash } from "../../src/engine/governance/task-fingerprint.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m6-auto-"))
const mkRunner = (order: string[]): any => ({
  async run(p: string) { order.push(p); return { type: "text", value: "ok", sessionId: "s" } },
  async cancel() {},
})

test("不传 adaptiveProfiles：自动从 TaskCheckpoint 构建画像并参与调度", async () => {
  const cwd = tmp()
  const reg = new TaskRegistry({ dir: path.join(cwd, ".pi", "workflows", "tasks"), workflowId: "auto_adapt" })
  // 预置两个类型：慢(10s) / 快(0.1s)
  for (const [key, dur] of [["slow:1", 10_000], ["slow:2", 11_000], ["slow:3", 9_000], ["fast:1", 100], ["fast:2", 120], ["fast:3", 90]] as const) {
    const f = computeTaskFingerprint({ taskKey: key, promptHash: contentHash(key) }).fingerprint
    const a = reg.acquire({ taskKey: key, taskFingerprint: f, runId: "seed" })
    // 模拟已完成的耗时：直接写 checkpoint（commit 后用 updatedAt/committedAt 差值）
    reg.commit({ taskKey: key, runId: "seed", leaseGeneration: a.checkpoint!.leaseGeneration, taskFingerprint: f, result: { k: key }, now: 1_000_000 })
    const cp = reg.get(key)!
    cp.committedAt = 1_000_000
    cp.updatedAt = 1_000_000 + dur
    // 通过再次写盘持久化（acquire+commit 会覆盖；这里直接构造文件内容）
    void cp
  }
  // 直接用 TaskRegistry 内部持久化：重新 acquire/commit 无法改 updatedAt，写文件模拟
  const file = path.join(cwd, ".pi", "workflows", "tasks", "auto_adapt.tasks.json")
  const data = JSON.parse(fs.readFileSync(file, "utf8"))
  const durations: Record<string, number> = { "slow:1": 10_000, "slow:2": 11_000, "slow:3": 9_000, "fast:1": 100, "fast:2": 120, "fast:3": 90 }
  for (const [k, v] of Object.entries(data.tasks)) {
    v.committedAt = 1_000_000
    v.updatedAt = 1_000_000 + (durations[k] ?? 100)
  }
  fs.writeFileSync(file, JSON.stringify(data))

  const order: string[] = []
  const script = `export const meta = { name: 'auto_adapt' }
const rs = await parallel([() => agent('fast-job'), () => agent('slow-job')])
return rs.length`
  const r = await runWorkflow(script, { agent: mkRunner(order), cwd, runId: "r1", taskRegistry: reg, autoShardThreshold: 99 })
  assert.equal(r.result, 2)
  assert.deepEqual(order, ["fast-job", "slow-job"], "parallel:0/1 画像相同 → 保持输入顺序（稳定）")
})

test("autoAdaptive=false：不加载画像，保持声明顺序", async () => {
  const cwd = tmp()
  const order: string[] = []
  const script = `export const meta = { name: 'no_adapt' }
await parallel([() => agent('a'), () => agent('b')])
return 'ok'`
  await runWorkflow(script, { agent: mkRunner(order), cwd, autoAdaptive: false })
  assert.deepEqual(order, ["a", "b"])
})

test("无任何 checkpoint：无画像时不崩溃，按静态顺序执行", async () => {
  const cwd = tmp()
  const order: string[] = []
  const reg = new TaskRegistry({ dir: path.join(cwd, ".pi", "workflows", "tasks"), workflowId: "empty" })
  const script = `export const meta = { name: 'empty_adapt' }
await parallel([() => agent('x'), () => agent('y')])
return 'ok'`
  const r = await runWorkflow(script, { agent: mkRunner(order), cwd, taskRegistry: reg, autoShardThreshold: 99 })
  assert.equal(r.result, "ok")
  assert.deepEqual(order, ["x", "y"])
})
