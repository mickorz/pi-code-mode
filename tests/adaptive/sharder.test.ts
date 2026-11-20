/**
 * M4-T1 契约测试：确定性分片器 + 租约自动续期
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { planShardedTasks, shardItems, verifyShards } from "../../src/engine/adaptive/sharder.js"
import { BatchExecutor } from "../../src/engine/governance/batch-executor.js"
import { contentHash } from "../../src/engine/governance/task-fingerprint.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m4-shard-"))

test("count 策略：按条数切分，无遗漏无重复", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: i }))
  const r = shardItems(items, { strategy: "count", limit: 3 })
  assert.equal(r.shards.length, 4)
  assert.deepEqual(r.shards.map((s) => s.items.length), [3, 3, 3, 1])
  assert.equal(verifyShards(items, r).ok, true)
})

test("确定性：同输入同参数 → 分片结果完全一致", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: i, text: `x${i}` }))
  const a = shardItems(items, { strategy: "count", limit: 7 })
  const b = shardItems(items, { strategy: "count", limit: 7 })
  assert.deepEqual(a.shards.map((s) => s.key), b.shards.map((s) => s.key))
  assert.equal(a.stats.deterministic, b.stats.deterministic)
})

test("bytes 策略：按字节上限切分，单条超限独占一片（不丢不拆）", () => {
  const items = ["aaa", "bbb", "c".repeat(100), "ddd"]
  const r = shardItems(items, { strategy: "bytes", limit: 10, serialize: (v) => String(v) })
  // "aaa"=3 + "bbb"=3 = 6 ≤ 10；加 100 字节超限 → 独占
  assert.equal(r.shards.length, 3)
  assert.deepEqual(r.shards[1]!.items, ["c".repeat(100)])
  assert.equal(verifyShards(items, r).ok, true)
})

test("boundary 策略：同分组键不跨片", () => {
  const items = [
    { stage: "a", n: 1 },
    { stage: "a", n: 2 },
    { stage: "b", n: 3 },
    { stage: "b", n: 4 },
  ]
  const r = shardItems(items, { strategy: "boundary", limit: 10, boundaryKey: (i: any) => i.stage })
  assert.equal(r.shards.length, 2)
  assert.deepEqual(r.shards.map((s) => s.boundary), ["a", "b"])
  assert.equal(verifyShards(items, r).ok, true)
})

test("boundary 策略：组内超限继续切分（不丢数据）", () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ stage: "a", n: i }))
  const r = shardItems(items, { strategy: "boundary", limit: 3, boundaryKey: (i: any) => i.stage })
  assert.equal(r.shards.length, 3)
  assert.equal(verifyShards(items, r).ok, true)
})

test("空输入：返回 0 片且校验通过", () => {
  const r = shardItems([], { limit: 5 })
  assert.equal(r.shards.length, 0)
  assert.equal(verifyShards([], r).ok, true)
})

test("verifyShards：能检出重复", () => {
  const items = [{ id: 1 }, { id: 2 }]
  const r = shardItems(items, { limit: 10 })
  r.shards.push({ key: "dup", items: [items[0]], estimatedBytes: 0 })
  const v = verifyShards(items, r)
  assert.equal(v.ok, false)
  assert.ok(v.duplicated > 0)
})

test("planShardedTasks：三层上下文产物（shared/tasks/evidence）", () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ id: i }))
  const shard = shardItems(items, { limit: 3, keyPrefix: "scan" })
  const plan = planShardedTasks({ items, shard, sharedRef: "ctx://rules", sharedDescription: "游戏规则（按引用传递）" })
  assert.equal(plan.shared.ref, "ctx://rules")
  assert.equal(plan.tasks.length, 2)
  assert.equal(plan.tasks[0]!.taskKey, "scan-0")
  assert.equal(plan.evidence.length, 2, "每片保留原始证据引用")
  assert.equal(plan.evidence[0]!.itemCount, 3)
  assert.match(plan.evidence[0]!.ref, /ctx:\/\/rules#scan-0/, "证据引用可定位回原始来源")
})

test("租约自动续期：长任务期间不被其他 Executor 接管", async () => {
  const cwd = tmp()
  let contested = 0
  const mkExec = (runId: string, leaseMs: number) =>
    new BatchExecutor({ workflowId: "wf", runId, cwd, leaseMs, concurrency: 1 })

  const longTask = {
    taskKey: "long",
    fingerprint: { promptHash: contentHash("p") },
    run: async () => {
      // 执行时间 > leaseMs，靠自动续期存活
      await new Promise((r) => setTimeout(r, 700))
      return { done: true }
    },
  }
  const slow = mkExec("runA", 400).run([longTask])
  // 中期另一个 Executor 尝试抢同一任务
  await new Promise((r) => setTimeout(r, 300))
  const rival = await mkExec("runB", 400).run([
    { taskKey: "long", fingerprint: { promptHash: contentHash("p") }, run: async () => { contested++; return { by: "B" } } },
  ])
  const a = await slow
  assert.equal(a.outcomes[0]!.status, "done", "长任务应成功完成（续期保活）")
  // 竞争方：租约仍有效时被拒（status=failed + 无法取得执行权），或任务已完成时复用
  const rivalOutcome = rival.outcomes[0]!
  const rejected = rivalOutcome.status === "failed" && /无法取得执行权|租约/.test(rivalOutcome.error ?? "")
  const reused = rivalOutcome.status === "done" && rivalOutcome.reused === true
  assert.ok(rejected || reused, `竞争方应被拒或复用，实际 ${JSON.stringify(rivalOutcome)}`)
  assert.equal(contested, 0, "竞争方绝不应重复执行同一任务")
})
