/**
 * M3-T1/T3 契约测试：TaskRegistry（lease/Fencing/原子提交/一致性/分层指纹复用）
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { computeTaskFingerprint, contentHash, externalDepsHash, modelConfigHash } from "../../packages/engine/src/governance/task-fingerprint.js"
import { TaskRegistry } from "../../packages/engine/src/governance/task-registry.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m3-task-"))
const fp = (key = "t1", extra: Partial<Parameters<typeof computeTaskFingerprint>[0]> = {}) =>
  computeTaskFingerprint({ taskKey: key, promptHash: contentHash("prompt"), inputHash: contentHash("input"), ...extra })

test("acquire：首次取得执行权，generation=1", () => {
  const r = new TaskRegistry({ dir: tmp(), workflowId: "wf" })
  const a = r.acquire({ taskKey: "t1", taskFingerprint: fp().fingerprint, runId: "runA" })
  assert.equal(a.ok, true)
  assert.equal(a.checkpoint!.leaseGeneration, 1)
  assert.equal(a.checkpoint!.attempt, 1)
})

test("acquire：他人持有未过期 → lease-held（防双重执行）", () => {
  const dir = tmp()
  const r1 = new TaskRegistry({ dir, workflowId: "wf" })
  r1.acquire({ taskKey: "t1", taskFingerprint: fp().fingerprint, runId: "runA", leaseMs: 60000 })
  const r2 = new TaskRegistry({ dir, workflowId: "wf" })
  const a = r2.acquire({ taskKey: "t1", taskFingerprint: fp().fingerprint, runId: "runB" })
  assert.equal(a.ok, false)
  assert.equal(a.reason, "lease-held")
})

test("acquire：lease 过期后可接管，generation+1（Fencing）", () => {
  const dir = tmp()
  const r1 = new TaskRegistry({ dir, workflowId: "wf" })
  r1.acquire({ taskKey: "t1", taskFingerprint: fp().fingerprint, runId: "runA", leaseMs: 1000, now: 0 })
  const r2 = new TaskRegistry({ dir, workflowId: "wf" })
  const a = r2.acquire({ taskKey: "t1", taskFingerprint: fp().fingerprint, runId: "runB", now: 5000 })
  assert.equal(a.ok, true)
  assert.equal(a.checkpoint!.leaseGeneration, 2, "接管必须 generation+1")
  assert.equal(a.checkpoint!.leaseOwner, "runB")
})

test("commit：Fencing 生效——旧执行者无法覆盖新执行者结果", () => {
  const dir = tmp()
  const r = new TaskRegistry({ dir, workflowId: "wf" })
  const f = fp().fingerprint
  r.acquire({ taskKey: "t1", taskFingerprint: f, runId: "runA", leaseMs: 1000, now: 0 })
  const b = r.acquire({ taskKey: "t1", taskFingerprint: f, runId: "runB", now: 5000 })
  const commitB = r.commit({ taskKey: "t1", runId: "runB", leaseGeneration: b.checkpoint!.leaseGeneration, taskFingerprint: f, result: { from: "B" } })
  assert.equal(commitB.ok, true)
  const commitA = r.commit({ taskKey: "t1", runId: "runA", leaseGeneration: 1, taskFingerprint: f, result: { from: "A" } })
  assert.equal(commitA.ok, false)
  assert.equal(commitA.reason, "lease-lost")
  assert.deepEqual(r.readResult("t1"), { from: "B" }, "结果应保持 B 的产物")
})

test("commit：产物原子落盘且可读回", () => {
  const dir = tmp()
  const r = new TaskRegistry({ dir, workflowId: "wf" })
  const a = r.acquire({ taskKey: "t1", taskFingerprint: fp().fingerprint, runId: "runA" })
  const c = r.commit({ taskKey: "t1", runId: "runA", leaseGeneration: a.checkpoint!.leaseGeneration, taskFingerprint: fp().fingerprint, result: { ok: 1 } })
  assert.equal(c.ok, true)
  assert.ok(c.checkpoint!.resultRef)
  assert.deepEqual(r.readResult("t1"), { ok: 1 })
  assert.equal(c.checkpoint!.sideEffect!.artifactPersisted, true)
})

test("commit：resultRef 指向不存在文件 → artifact-missing 拒绝（一致性规则 3）", () => {
  const r = new TaskRegistry({ dir: tmp(), workflowId: "wf" })
  const a = r.acquire({ taskKey: "t1", taskFingerprint: fp().fingerprint, runId: "runA" })
  const c = r.commit({ taskKey: "t1", runId: "runA", leaseGeneration: a.checkpoint!.leaseGeneration, taskFingerprint: fp().fingerprint, resultRef: "artifacts/nope.json" })
  assert.equal(c.ok, false)
  assert.equal(c.reason, "artifact-missing")
})

test("副作用四状态：executed/artifactPersisted/sideEffectCommitted/idempotent 独立记录", () => {
  const r = new TaskRegistry({ dir: tmp(), workflowId: "wf" })
  const a = r.acquire({ taskKey: "t1", taskFingerprint: fp().fingerprint, runId: "runA" })
  const c = r.commit({
    taskKey: "t1",
    runId: "runA",
    leaseGeneration: a.checkpoint!.leaseGeneration,
    taskFingerprint: fp().fingerprint,
    result: { x: 1 },
    sideEffect: { sideEffectCommitted: false, idempotent: false, idempotencyKey: "publish-42" },
  })
  assert.equal(c.ok, true)
  const cp = r.get("t1")!
  assert.equal(cp.sideEffect!.executed, true)
  assert.equal(cp.sideEffect!.artifactPersisted, true)
  assert.equal(cp.sideEffect!.sideEffectCommitted, false, "checkpoint 提交 ≠ 副作用成功")
  assert.equal(cp.sideEffect!.idempotent, false)
  assert.equal(cp.sideEffect!.idempotencyKey, "publish-42")
})

test("reusable：指纹一致 + done → 可复用；指纹不同 → 不可复用", () => {
  const r = new TaskRegistry({ dir: tmp(), workflowId: "wf" })
  const f1 = fp().fingerprint
  const a = r.acquire({ taskKey: "t1", taskFingerprint: f1, runId: "runA" })
  r.commit({ taskKey: "t1", runId: "runA", leaseGeneration: a.checkpoint!.leaseGeneration, taskFingerprint: f1, result: { v: 1 } })
  assert.equal(r.reusable("t1", f1).reusable, true)
  const f2 = computeTaskFingerprint({ taskKey: "t1", promptHash: contentHash("changed") }).fingerprint
  const rr = r.reusable("t1", f2)
  assert.equal(rr.reusable, false)
  assert.equal(rr.reason, "fingerprint-mismatch")
})

test("reusable：非幂等且副作用未确认 → 不可复用（防重复发布）", () => {
  const r = new TaskRegistry({ dir: tmp(), workflowId: "wf" })
  const f = fp().fingerprint
  const a = r.acquire({ taskKey: "t1", taskFingerprint: f, runId: "runA" })
  r.commit({ taskKey: "t1", runId: "runA", leaseGeneration: a.checkpoint!.leaseGeneration, taskFingerprint: f, result: { v: 1 }, sideEffect: { sideEffectCommitted: false, idempotent: false } })
  assert.equal(r.reusable("t1", f).reason, "side-effect-unconfirmed")
})

test("acquire：done 且指纹一致 → already-done（调用方跳过，不重跑）", () => {
  const r = new TaskRegistry({ dir: tmp(), workflowId: "wf" })
  const f = fp().fingerprint
  const a = r.acquire({ taskKey: "t1", taskFingerprint: f, runId: "runA" })
  r.commit({ taskKey: "t1", runId: "runA", leaseGeneration: a.checkpoint!.leaseGeneration, taskFingerprint: f, result: {} })
  const again = r.acquire({ taskKey: "t1", taskFingerprint: f, runId: "runB" })
  assert.equal(again.ok, false)
  assert.equal(again.reason, "already-done")
})

test("rebuildFromCheckpoints：产物缺失的 done 降级为 failed（Registry 可校正）", () => {
  const dir = tmp()
  const r = new TaskRegistry({ dir, workflowId: "wf" })
  const f = fp().fingerprint
  const a = r.acquire({ taskKey: "t1", taskFingerprint: f, runId: "runA" })
  const c = r.commit({ taskKey: "t1", runId: "runA", leaseGeneration: a.checkpoint!.leaseGeneration, taskFingerprint: f, result: { v: 1 } })
  fs.rmSync(path.resolve(dir, c.checkpoint!.resultRef!))
  const { corrected } = r.rebuildFromCheckpoints()
  assert.equal(corrected, 1)
  assert.equal(r.get("t1")!.status, "failed")
})

test("fail：保留 generation 并释放租约（允许接管）", () => {
  const dir = tmp()
  const r = new TaskRegistry({ dir, workflowId: "wf" })
  const f = fp().fingerprint
  const a = r.acquire({ taskKey: "t1", taskFingerprint: f, runId: "runA" })
  assert.equal(r.fail({ taskKey: "t1", runId: "runA", leaseGeneration: a.checkpoint!.leaseGeneration, error: "boom" }), true)
  const b = new TaskRegistry({ dir, workflowId: "wf" }).acquire({ taskKey: "t1", taskFingerprint: f, runId: "runB" })
  assert.equal(b.ok, true)
  assert.equal(b.checkpoint!.leaseGeneration, 2)
})

test("分层指纹：执行契约/外部依赖变化使指纹失效（外部依赖仅任务级）", () => {
  const base = { taskKey: "t1", promptHash: contentHash("p") }
  const f1 = computeTaskFingerprint(base).fingerprint
  const f2 = computeTaskFingerprint({ ...base, executionContractVersion: "v2" }).fingerprint
  assert.notEqual(f1, f2, "执行契约版本变化必须失效")
  const clientTask = computeTaskFingerprint({ ...base, externalDeps: { "client-code": "sha:a" } }).fingerprint
  const clientChanged = computeTaskFingerprint({ ...base, externalDeps: { "client-code": "sha:b" } }).fingerprint
  assert.notEqual(clientTask, clientChanged)
  const rulesTask = computeTaskFingerprint({ ...base, taskKey: "t2", externalDeps: { "rule-doc": "sha:x" } }).fingerprint
  const rulesAfterClientChange = computeTaskFingerprint({ ...base, taskKey: "t2", externalDeps: { "rule-doc": "sha:x" } }).fingerprint
  assert.equal(rulesTask, rulesAfterClientChange, "无关外部依赖变化不影响该任务")
})

test("modelConfigHash：模型 ID 与关键参数均参与", () => {
  assert.notEqual(modelConfigHash({ model: "a" }), modelConfigHash({ model: "b" }))
  assert.notEqual(modelConfigHash({ model: "a", params: { temperature: 0.2 } }), modelConfigHash({ model: "a", params: { temperature: 0.9 } }))
})

test("externalDepsHash：键序无关", () => {
  assert.equal(externalDepsHash({ a: "1", b: "2" }), externalDepsHash({ b: "2", a: "1" }))
})

test("持久化：新实例可读到既有 checkpoint（跨 run 复用基础）", () => {
  const dir = tmp()
  const f = fp().fingerprint
  const r1 = new TaskRegistry({ dir, workflowId: "wf" })
  const a = r1.acquire({ taskKey: "t1", taskFingerprint: f, runId: "runA" })
  r1.commit({ taskKey: "t1", runId: "runA", leaseGeneration: a.checkpoint!.leaseGeneration, taskFingerprint: f, result: { v: 42 } })
  const r2 = new TaskRegistry({ dir, workflowId: "wf" })
  assert.deepEqual(r2.readResult("t1"), { v: 42 })
  assert.equal(r2.reusable("t1", f).reusable, true)
})
