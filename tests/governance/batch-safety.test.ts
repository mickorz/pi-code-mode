/**
 * M6-P1-1 契约测试：BatchExecutor 安全边界（缺指纹/超时/续租联动）
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { BatchExecutor } from "../../packages/engine/src/governance/batch-executor.js"
import { contentHash } from "../../packages/engine/src/governance/task-fingerprint.js"
import { TaskRegistry } from "../../packages/engine/src/governance/task-registry.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m6-bsafe-"))

test("缺 fingerprint → 明确失败（不再只 hash taskKey 导致陈旧复用）", async () => {
  const cwd = tmp()
  const ex = new BatchExecutor({ workflowId: "wf", runId: "r1", cwd })
  const r = await ex.run([{ taskKey: "t1", run: async () => 1 } as any])
  assert.equal(r.outcomes[0]!.status, "failed")
  assert.match(r.outcomes[0]!.error!, /缺少 fingerprint/)
})

test("taskTimeoutMs：任务超时即失败并释放租约（可被后续 run 接管）", async () => {
  const cwd = tmp()
  const ex = new BatchExecutor({ workflowId: "wf", runId: "r1", cwd, taskTimeoutMs: 200, leaseMs: 5_000 })
  const r = await ex.run([
    {
      taskKey: "hang",
      fingerprint: { promptHash: contentHash("p") },
      run: () => new Promise(() => {}), // 永不 resolve
    },
  ])
  assert.equal(r.outcomes[0]!.status, "failed")
  assert.match(r.outcomes[0]!.error!, /超时/)

  // 租约已释放（fail 会把 leaseExpiresAt 置 0）→ 新 run 可接管
  const reg = new TaskRegistry({ dir: path.join(cwd, ".pi", "workflows", "tasks"), workflowId: "wf" })
  const cp = reg.get("hang")!
  assert.equal(cp.status, "failed")
  assert.equal(cp.leaseExpiresAt, 0)
})

test("超时后不继续续租（否则挂死任务永久占槽）", async () => {
  const cwd = tmp()
  const ex = new BatchExecutor({ workflowId: "wf", runId: "r1", cwd, taskTimeoutMs: 100, leaseMs: 300 })
  const before = Date.now()
  const r = await ex.run([
    { taskKey: "hang2", fingerprint: { promptHash: contentHash("p") }, run: () => new Promise(() => {}) },
  ])
  assert.equal(r.outcomes[0]!.status, "failed")
  assert.ok(Date.now() - before < 3000, "应在超时后很快结束，不被续租拖住")
})

test("输入变化（不同 fingerprint）→ 不复用旧产物", async () => {
  const cwd = tmp()
  let calls = 0
  const mk = (h: string) => ({
    taskKey: "t",
    fingerprint: { promptHash: contentHash(h) },
    run: async () => {
      calls++
      return { h }
    },
  })
  await new BatchExecutor({ workflowId: "wf", runId: "r1", cwd }).run([mk("v1")])
  const r = await new BatchExecutor({ workflowId: "wf", runId: "r2", cwd }).run([mk("v2")])
  assert.equal(r.stats.reused, 0, "指纹变化必须重跑")
  assert.equal(calls, 2)
})
