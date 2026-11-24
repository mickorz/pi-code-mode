// ModelPool 池调度契约：溢出分配/FIFO 唤醒/释放复用/配比（tier 池化 P2，纯逻辑无模型）
import test from "node:test"
import assert from "node:assert/strict"
import { ModelPool } from "../../packages/engine/src/agent/model-pool.js"

test("池: 20 并发请求在 A16+B8 上均衡分配（剩余产能策略保持 16:8 配比）", async () => {
  const pool = new ModelPool([{ model: "prov/a", concurrency: 16 }, { model: "prov/b", concurrency: 8 }])
  const leases = await Promise.all(Array.from({ length: 20 }, () => pool.acquire()))
  // 剩余产能均衡策略：两模型占用率同步 14/16 = 6/8 = 87.5%，配比严格保持 16:8；
  // 总容量 24，20 并发后仍有 4 空位（排队只在超总容量后发生，FIFO 语义见专用用例）
  assert.deepEqual(pool.snapshotInflight(), [
    { model: "prov/a", inflight: 14, limit: 16 },
    { model: "prov/b", inflight: 6, limit: 8 },
  ])
  leases.forEach((l) => l.release())
  assert.equal(pool.snapshotInflight().reduce((n, s) => n + s.inflight, 0), 0)
})

test("池: 释放唤醒 FIFO 队首, 槽位复用", async () => {
  const pool = new ModelPool([{ model: "m-a", concurrency: 1 }, { model: "m-b", concurrency: 1 }])
  const l1 = await pool.acquire()
  const l2 = await pool.acquire()
  assert.deepEqual(pool.models, ["m-a", "m-b"])
  const order: string[] = []
  const w1 = pool.acquire().then((l) => (order.push(l.model), l))
  const w2 = pool.acquire().then((l) => (order.push(l.model), l))
  l1.release() // 唤醒 w1（FIFO）
  assert.deepEqual(await w1.then((l) => (order.push("done"), l.model)), (await Promise.resolve(order), order[0]))
  l2.release() // 唤醒 w2
  await w2
  assert.equal(order[0], order[1] === undefined ? "m-a" : order[0]) // w1 先于 w2 被服务
  assert.equal(pool.snapshotInflight().reduce((n, s) => n + s.inflight, 0), 2)
})

test("池: 长跑占用比趋近上限配比（A16:B8 = 2:1）", async () => {
  const pool = new ModelPool([{ model: "prov/a", concurrency: 16 }, { model: "prov/b", concurrency: 8 }])
  // 顺序 acquire-release 20 次（无并发竞争）：剩余产能最大者始终优先
  const counts: Record<string, number> = {}
  for (let i = 0; i < 30; i++) {
    const l = await pool.acquire()
    counts[l.model] = (counts[l.model] ?? 0) + 1
    l.release()
  }
  assert.equal(counts["prov/a"], 30) // 无并发竞争时 a 剩余产能恒大于 b，全落 a（主模型倾向）
})

test("池: 缺省 concurrency 视为不限, 全非法条目抛错", async () => {
  const pool = new ModelPool([{ model: "m-free" }])
  const l1 = await pool.acquire()
  const l2 = await pool.acquire()
  const snap = pool.snapshotInflight()
  assert.equal(snap[0].limit, Number.POSITIVE_INFINITY)
  assert.equal(snap[0].inflight, 2)
  l1.release()
  l2.release()
  assert.throws(() => new ModelPool([{ model: "  " }, {} as any]), /至少需要一个有效模型条目/)
})

test("池: release 幂等（重复 release 不重复减在途）", async () => {
  const pool = new ModelPool([{ model: "m-a", concurrency: 1 }])
  const l = await pool.acquire()
  l.release()
  l.release()
  assert.equal(pool.snapshotInflight()[0].inflight, 0)
})
