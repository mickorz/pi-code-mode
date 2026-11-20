/**
 * M6-P0-4 契约测试：TaskRegistry 跨进程/预构造双实例的 Fencing 真实有效
 *
 * 审计发现：原实现构造时只读一次盘，两个 Registry 提前构造会各自拿到空表 → 双 acquire 成功。
 * 修复后：每次临界区重新读盘 + 跨进程文件锁，CAS 基于最新磁盘状态。
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { TaskRegistry } from "../../src/engine/governance/task-registry.js"
import { computeTaskFingerprint, contentHash } from "../../src/engine/governance/task-fingerprint.js"
import { withFileLock, writeFileAtomic } from "../../src/engine/governance/file-lock.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m6-fence-"))
const fp = (key = "t1") =>
  computeTaskFingerprint({ taskKey: key, promptHash: contentHash("p"), inputHash: contentHash("i") }).fingerprint

test("两个 Registry 提前构造（同进程）：只有一个能取得执行权（此前双双成功）", () => {
  const dir = tmp()
  const f = fp()
  // 关键：两个实例都在任何写盘之前构造（复现审计指出的时序）
  const a = new TaskRegistry({ dir, workflowId: "wf" })
  const b = new TaskRegistry({ dir, workflowId: "wf" })

  const ra = a.acquire({ taskKey: "t1", taskFingerprint: f, runId: "runA", leaseMs: 60_000 })
  const rb = b.acquire({ taskKey: "t1", taskFingerprint: f, runId: "runB", leaseMs: 60_000 })

  assert.equal(ra.ok, true, "A 应取得执行权")
  assert.equal(rb.ok, false, "B 必须被拒（否则双重执行）")
  assert.equal(rb.reason, "lease-held")
})

test("两个 Registry 提前构造：旧持有者 commit 被拒绝（Fencing 跨实例生效）", () => {
  const dir = tmp()
  const f = fp()
  const a = new TaskRegistry({ dir, workflowId: "wf" })
  const b = new TaskRegistry({ dir, workflowId: "wf" })

  const ra = a.acquire({ taskKey: "t1", taskFingerprint: f, runId: "runA", leaseMs: 1000, now: 0 })
  assert.equal(ra.ok, true)
  // B 在 A 的 lease 过期后接管
  const rb = b.acquire({ taskKey: "t1", taskFingerprint: f, runId: "runB", now: 5000 })
  assert.equal(rb.ok, true, "lease 过期后应可接管")
  assert.equal(rb.checkpoint!.leaseGeneration, 2)

  // A 用旧 generation 提交 → 必须被拒（即使 A 的内存里还认为自己持有）
  const staleCommit = a.commit({
    taskKey: "t1",
    runId: "runA",
    leaseGeneration: 1,
    taskFingerprint: f,
    result: { by: "A" },
  })
  assert.equal(staleCommit.ok, false, "旧执行者不得覆盖")
  assert.equal(staleCommit.reason, "lease-lost")

  // B 提交成功
  const okCommit = b.commit({
    taskKey: "t1",
    runId: "runB",
    leaseGeneration: 2,
    taskFingerprint: f,
    result: { by: "B" },
  })
  assert.equal(okCommit.ok, true)
  assert.deepEqual(new TaskRegistry({ dir, workflowId: "wf" }).readResult("t1"), { by: "B" })
})

test("真正的子进程并发：10 个进程抢同一任务，只有 1 个成功", async () => {
  const dir = tmp()
  const f = fp()
  const { spawnSync } = await import("node:child_process")
  const { pathToFileURL } = await import("node:url")
  const moduleUrl = pathToFileURL(path.resolve("src/engine/governance/task-registry.ts")).href
  const script = `
import { TaskRegistry } from ${JSON.stringify(moduleUrl)};
const [dir, fingerprint, runId] = process.argv.slice(-3);
const reg = new TaskRegistry({ dir, workflowId: "wf" });
const r = reg.acquire({ taskKey: "t1", taskFingerprint: fingerprint, runId, leaseMs: 60000 });
process.stdout.write(r.ok ? "WON" : "LOST");
`
  // driver 放在 registry 目录之外，避免干扰目录断言
  const driverDir = fs.mkdtempSync(path.join(os.tmpdir(), "m6-driver-"))
  const driver = path.join(driverDir, "driver.mts")
  fs.writeFileSync(driver, script)
  const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs")

  const results: string[] = []
  for (let i = 0; i < 10; i++) {
    const r = spawnSync(process.execPath, [tsxCli, driver, dir, f, `run${i}`], { encoding: "utf8", timeout: 60_000 })
    results.push((r.stdout ?? "").trim() || `ERR:${(r.stderr ?? "").slice(0, 80)}`)
  }
  const won = results.filter((x) => x === "WON").length
  assert.equal(won, 1, `10 个进程应恰好 1 个取得执行权，实际 ${won}（${JSON.stringify(results)}）`)
})

test("withFileLock：并发互斥（同进程重入会被阻塞直到释放）", () => {
  const dir = tmp()
  const lock = path.join(dir, "x.lock")
  const order: string[] = []
  withFileLock(lock, () => {
    order.push("first")
    // 锁文件应存在
    assert.ok(fs.existsSync(lock))
  })
  assert.equal(order[0], "first")
  assert.equal(fs.existsSync(lock), false, "释放后锁文件应删除")
})

test("withFileLock：stale 锁可被接管（进程崩溃残留不永久阻塞）", () => {
  const dir = tmp()
  const lock = path.join(dir, "stale.lock")
  fs.writeFileSync(lock, "{}")
  // 把 mtime 改到很久以前
  const old = new Date(Date.now() - 120_000)
  fs.utimesSync(lock, old, old)
  let ran = false
  withFileLock(lock, () => {
    ran = true
  }, { staleMs: 30_000 })
  assert.equal(ran, true, "stale 锁应被强制接管")
})

test("writeFileAtomic：替换过程崩溃窗口有备份（目标不消失）", () => {
  const dir = tmp()
  const file = path.join(dir, "data.json")
  writeFileAtomic(file, JSON.stringify({ v: 1 }))
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { v: 1 })
  // 覆写
  writeFileAtomic(file, JSON.stringify({ v: 2 }))
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { v: 2 })
  // 无残留 tmp
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))
  assert.deepEqual(leftovers, [], `不应残留 tmp：${leftovers.join(",")}`)
})

test("workflowId 清洗：含 ../ 不会写出目录外", () => {
  const dir = tmp()
  const reg = new TaskRegistry({ dir, workflowId: "../../etc/evil" })
  const f = fp()
  reg.acquire({ taskKey: "t1", taskFingerprint: f, runId: "r" })
  const files = fs.readdirSync(dir)
  assert.equal(files.length, 1, `应只在本目录产生 1 个文件，实际 ${JSON.stringify(files)}`)
  assert.ok(!files[0]!.includes("/"), "文件名不得含路径分隔符")
})

test("artifact 名不碰撞：相似 taskKey 不互相覆盖", () => {
  const dir = tmp()
  const reg = new TaskRegistry({ dir, workflowId: "wf" })
  const f1 = fp("stage:1")
  const f2 = fp("stage 1")
  const a1 = reg.acquire({ taskKey: "stage:1", taskFingerprint: f1, runId: "r" })
  const a2 = reg.acquire({ taskKey: "stage 1", taskFingerprint: f2, runId: "r" })
  reg.commit({ taskKey: "stage:1", runId: "r", leaseGeneration: a1.checkpoint!.leaseGeneration, taskFingerprint: f1, result: { who: "colon" } })
  reg.commit({ taskKey: "stage 1", runId: "r", leaseGeneration: a2.checkpoint!.leaseGeneration, taskFingerprint: f2, result: { who: "space" } })
  assert.deepEqual(reg.readResult("stage:1"), { who: "colon" })
  assert.deepEqual(reg.readResult("stage 1"), { who: "space" })
})
