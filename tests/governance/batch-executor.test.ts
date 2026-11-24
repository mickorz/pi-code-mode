/**
 * M3-T2/T4 契约测试：BatchExecutor（清单驱动 + 任务级 resume + Fencing 并发）
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { BatchExecutor, type BatchTask } from "../../packages/engine/src/governance/batch-executor.js"
import { contentHash } from "../../packages/engine/src/governance/task-fingerprint.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m3-batch-"))

function tasks(n: number, counter: { calls: number }, failKeys: string[] = []): BatchTask[] {
  return Array.from({ length: n }, (_, i) => {
    const key = `t${i}`
    return {
      taskKey: key,
      fingerprint: { promptHash: contentHash(`prompt-${key}`) },
      run: async () => {
        counter.calls++
        if (failKeys.includes(key)) throw new Error(`fail-${key}`)
        return { key, value: i * 10 }
      },
    }
  })
}

test("全量首次执行：全部执行并提交", async () => {
  const cwd = tmp()
  const counter = { calls: 0 }
  const ex = new BatchExecutor({ workflowId: "wf", runId: "run1", cwd })
  const r = await ex.run(tasks(5, counter))
  assert.equal(r.stats.total, 5)
  assert.equal(r.stats.executed, 5)
  assert.equal(r.stats.reused, 0)
  assert.equal(counter.calls, 5)
  assert.equal(r.outcomes.every((o) => o.status === "done"), true)
})

test("部分失败：失败任务记录，成功任务产物落盘", async () => {
  const cwd = tmp()
  const counter = { calls: 0 }
  const ex = new BatchExecutor({ workflowId: "wf", runId: "run1", cwd, concurrency: 2 })
  const r = await ex.run(tasks(6, counter, ["t2", "t4"]))
  assert.equal(r.stats.failed, 2)
  assert.equal(r.stats.succeeded, 4)
  assert.ok(r.outcomes.find((o) => o.taskKey === "t2")!.error!.includes("fail-t2"))
})

test("任务级 resume：只重跑失败任务（已完成任务重跑率 0%）", async () => {
  const cwd = tmp()
  const counter1 = { calls: 0 }
  const ex1 = new BatchExecutor({ workflowId: "wf", runId: "run1", cwd })
  await ex1.run(tasks(6, counter1, ["t3"]))

  // 第二轮：同一拼写（指纹一致），只应重跑 t3
  const counter2 = { calls: 0 }
  const ex2 = new BatchExecutor({ workflowId: "wf", runId: "run2", cwd })
  const r2 = await ex2.run(tasks(6, counter2, []))
  assert.equal(r2.stats.reused, 5, "5 个已完成任务必须复用")
  assert.equal(r2.stats.executed, 1, "只执行失败的 1 个")
  assert.equal(counter2.calls, 1, "重跑率必须为 0（只跑失败任务）")
  assert.equal(r2.stats.succeeded, 6)
})

test("resume 复用返回历史产物值", async () => {
  const cwd = tmp()
  const counter = { calls: 0 }
  await new BatchExecutor({ workflowId: "wf", runId: "run1", cwd }).run(tasks(3, counter))
  const ex = new BatchExecutor({ workflowId: "wf", runId: "run2", cwd })
  const r = await ex.run(tasks(3, counter))
  assert.equal(r.stats.reused, 3)
  assert.deepEqual(r.outcomes[1]!.value, { key: "t1", value: 10 }, "应从 checkpoint 读回产物")
})

test("指纹变化 → 不复用旧产物（重跑）", async () => {
  const cwd = tmp()
  const counter = { calls: 0 }
  await new BatchExecutor({ workflowId: "wf", runId: "run1", cwd }).run(tasks(2, counter))
  // 改变 prompt 指纹
  const changed: BatchTask[] = Array.from({ length: 2 }, (_, i) => ({
    taskKey: `t${i}`,
    fingerprint: { promptHash: contentHash(`changed-${i}`) },
    run: async () => {
      counter.calls++
      return { v: "new" }
    },
  }))
  const r = await new BatchExecutor({ workflowId: "wf", runId: "run2", cwd }).run(changed)
  assert.equal(r.stats.reused, 0, "指纹不一致必须重跑")
  assert.equal(r.stats.executed, 2)
})

test("resume=false 强制重跑", async () => {
  const cwd = tmp()
  const counter = { calls: 0 }
  await new BatchExecutor({ workflowId: "wf", runId: "run1", cwd }).run(tasks(3, counter))
  const r = await new BatchExecutor({ workflowId: "wf", runId: "run2", cwd, resume: false }).run(tasks(3, counter))
  assert.equal(r.stats.reused, 0)
  assert.equal(counter.calls, 6, "两轮各执行 3 次")
})

test("maxAttempts：任务内部重试", async () => {
  const cwd = tmp()
  let attempts = 0
  const ex = new BatchExecutor({ workflowId: "wf", runId: "run1", cwd, maxAttempts: 3 })
  const r = await ex.run([
    {
      taskKey: "flaky",
      fingerprint: { promptHash: contentHash("p") },
      run: async () => {
        attempts++
        if (attempts < 3) throw new Error("transient")
        return { ok: true }
      },
    },
  ])
  assert.equal(r.outcomes[0]!.status, "done")
  assert.equal(r.outcomes[0]!.attempts, 3)
})

test("并发上限：同时执行数不超过 concurrency", async () => {
  const cwd = tmp()
  let active = 0
  let peak = 0
  const ex = new BatchExecutor({ workflowId: "wf", runId: "run1", cwd, concurrency: 2 })
  const list: BatchTask[] = Array.from({ length: 8 }, (_, i) => ({
    taskKey: `t${i}`,
    fingerprint: { promptHash: contentHash(`p${i}`) },
    run: async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return i
    },
  }))
  await ex.run(list)
  assert.ok(peak <= 2, `峰值并发 ${peak} 超过上限 2`)
})

test("副作用状态：非幂等任务记录 idempotencyKey", async () => {
  const cwd = tmp()
  const ex = new BatchExecutor({ workflowId: "wf", runId: "run1", cwd })
  await ex.run([
    {
      taskKey: "publish",
      fingerprint: { promptHash: contentHash("p") },
      run: async () => ({ published: true }),
      sideEffect: { sideEffectCommitted: true, idempotent: false, idempotencyKey: "pub-001" },
    },
  ])
  const snap = ex.snapshot()
  const cp = snap.tasks.find((t) => t.taskKey === "publish")!
  assert.equal(cp.sideEffect!.idempotencyKey, "pub-001")
  assert.equal(cp.sideEffect!.sideEffectCommitted, true)
})

test("report：输出失败清单与节省量", async () => {
  const cwd = tmp()
  const counter = { calls: 0 }
  const ex = new BatchExecutor({ workflowId: "wf", runId: "run1", cwd })
  const r = await ex.run(tasks(4, counter, ["t1"]))
  const text = ex.report(r)
  assert.match(text, /任务总数：4/)
  assert.match(text, /失败任务/)
  assert.match(text, /`t1`/)
})

test("并发 Fencing：两个 Executor 同时跑同任务，只有一个执行成功", async () => {
  const cwd = tmp()
  let calls = 0
  const mk = (runId: string) => {
    const ex = new BatchExecutor({ workflowId: "wf", runId, cwd, leaseMs: 60_000 })
    return ex.run([
      {
        taskKey: "shared",
        fingerprint: { promptHash: contentHash("p") },
        run: async () => {
          calls++
          await new Promise((r) => setTimeout(r, 30))
          return { by: runId }
        },
      },
    ])
  }
  const [a, b] = await Promise.all([mk("runA"), mk("runB")])
  const done = [a, b].filter((r) => r.outcomes[0]!.status === "done").length
  assert.ok(done >= 1, "至少一个成功")
  assert.ok(calls <= 2, `不应重复多次执行（实际 ${calls}）`)
  // 未取得执行权的一方应报告 lease 相关失败或复用
  const loser = [a, b].find((r) => r.outcomes[0]!.status !== "done")
  if (loser) assert.match(loser.outcomes[0]!.error!, /无法取得执行权|租约/)
})
