/**
 * O3 apply / rollback 契约（2026-11-23）
 *
 * 硬不变量：
 *  - hash 校验在所有写入之前（stale → 整体拒绝，不做部分写入）
 *  - 备份在所有写入之前（备份失败 → 生产文件未改）
 *  - 原子写
 *  - rollback 遇到 apply 后被改动的文件默认拒绝，--force 才覆盖
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { applyToProduction, readBackupManifest, rollbackFromBackup } from "../../src/engine/optimizer/apply-service.js"
import { sha256 } from "../../src/engine/optimizer/target-resolver.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "opt-apply-"))

const ORIGINAL = `export const meta = { name: 'demo' }
const a = await agent('x', { retries: 2 })
return a
`
const PATCHED = `export const meta = { name: 'demo' }
const a = await agent('x', { retries: 1 })
return a
`

function setup(): { cwd: string; root: string; sessionDir: string } {
  const cwd = tmp()
  const root = path.join(cwd, "wf")
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, "demo.js"), ORIGINAL, "utf8")
  const sessionDir = path.join(cwd, "opt-1")
  fs.mkdirSync(sessionDir, { recursive: true })
  return { cwd, root, sessionDir }
}

test("apply：正常写回 + 备份 manifest 完整", () => {
  const { root, sessionDir } = setup()
  const before = sha256(ORIGINAL)
  const r = applyToProduction({
    sessionDir,
    optimizationId: "opt-1",
    targetRoot: root,
    items: [{ path: "demo.js", content: PATCHED, expectedSourceHash: before }],
  })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.applied.length, 1)
  assert.equal(fs.readFileSync(path.join(root, "demo.js"), "utf8"), PATCHED)

  const m = readBackupManifest(sessionDir)!
  assert.equal(m.optimizationId, "opt-1")
  assert.equal(m.files.length, 1)
  assert.equal(m.files[0]!.beforeHash, before)
  assert.equal(m.files[0]!.afterHash, sha256(PATCHED))
  // 备份内容 = 原文件
  const bak = fs.readFileSync(path.join(sessionDir, "backup", m.files[0]!.backupFile), "utf8")
  assert.equal(bak, ORIGINAL)
})

test("apply：source hash 不符 → 整体拒绝且生产文件不变", () => {
  const { root, sessionDir } = setup()
  fs.writeFileSync(path.join(root, "demo.js"), ORIGINAL + "// 被人改过\n", "utf8")
  const now = fs.readFileSync(path.join(root, "demo.js"), "utf8")
  const r = applyToProduction({
    sessionDir,
    optimizationId: "opt-1",
    targetRoot: root,
    items: [{ path: "demo.js", content: PATCHED, expectedSourceHash: sha256(ORIGINAL) }],
  })
  assert.equal(r.ok, false)
  assert.ok(r.error?.includes("stale"))
  assert.equal(r.stale?.length, 1)
  assert.equal(fs.readFileSync(path.join(root, "demo.js"), "utf8"), now, "生产文件必须原样不动")
  assert.equal(fs.existsSync(path.join(sessionDir, "backup", "manifest.json")), false, "stale 时不写备份")
})

test("apply：多文件中任一 stale → 全部不写（不做部分写入）", () => {
  const { root, sessionDir } = setup()
  fs.writeFileSync(path.join(root, "b.js"), "export const meta = { name: 'b' }\n", "utf8")
  // b.js 的期望 hash 故意给错
  const r = applyToProduction({
    sessionDir,
    optimizationId: "opt-1",
    targetRoot: root,
    items: [
      { path: "demo.js", content: PATCHED, expectedSourceHash: sha256(ORIGINAL) },
      { path: "b.js", content: "export const meta = { name: 'b2' }\n", expectedSourceHash: "sha256:wrong" },
    ],
  })
  assert.equal(r.ok, false)
  assert.equal(fs.readFileSync(path.join(root, "demo.js"), "utf8"), ORIGINAL, "demo.js 也必须不写")
})

test("apply：目标文件不存在 → stale 列表记录期望值", () => {
  const { root, sessionDir } = setup()
  const r = applyToProduction({
    sessionDir,
    optimizationId: "opt-1",
    targetRoot: root,
    items: [{ path: "missing.js", content: "x", expectedSourceHash: "sha256:abc" }],
  })
  assert.equal(r.ok, false)
  assert.equal(r.stale?.[0]?.path, "missing.js")
  assert.equal(r.stale?.[0]?.actual, undefined)
})

test("rollback：从备份恢复原内容", () => {
  const { root, sessionDir } = setup()
  applyToProduction({
    sessionDir,
    optimizationId: "opt-1",
    targetRoot: root,
    items: [{ path: "demo.js", content: PATCHED, expectedSourceHash: sha256(ORIGINAL) }],
  })
  const m = readBackupManifest(sessionDir)!
  const r = rollbackFromBackup({ sessionDir, manifest: m })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.restored, ["demo.js"])
  assert.equal(fs.readFileSync(path.join(root, "demo.js"), "utf8"), ORIGINAL)
})

test("rollback：apply 后文件又被改动 → 默认拒绝（防丢他人修改）", () => {
  const { root, sessionDir } = setup()
  applyToProduction({
    sessionDir,
    optimizationId: "opt-1",
    targetRoot: root,
    items: [{ path: "demo.js", content: PATCHED, expectedSourceHash: sha256(ORIGINAL) }],
  })
  fs.writeFileSync(path.join(root, "demo.js"), PATCHED + "// 后来又改了\n", "utf8")
  const m = readBackupManifest(sessionDir)!
  const r = rollbackFromBackup({ sessionDir, manifest: m })
  assert.equal(r.ok, false)
  assert.ok(r.error?.includes("拒绝覆盖"))
  assert.equal(r.drifted?.length, 1)
  assert.match(fs.readFileSync(path.join(root, "demo.js"), "utf8"), /后来又改了/, "默认不覆盖")
})

test("rollback：--force 允许覆盖已漂移文件", () => {
  const { root, sessionDir } = setup()
  applyToProduction({
    sessionDir,
    optimizationId: "opt-1",
    targetRoot: root,
    items: [{ path: "demo.js", content: PATCHED, expectedSourceHash: sha256(ORIGINAL) }],
  })
  fs.writeFileSync(path.join(root, "demo.js"), PATCHED + "// 后来又改了\n", "utf8")
  const m = readBackupManifest(sessionDir)!
  const r = rollbackFromBackup({ sessionDir, manifest: m, force: true })
  assert.equal(r.ok, true, r.error)
  assert.equal(fs.readFileSync(path.join(root, "demo.js"), "utf8"), ORIGINAL)
})

test("rollback：备份文件缺失 → 报错且不写入", () => {
  const { root, sessionDir } = setup()
  applyToProduction({
    sessionDir,
    optimizationId: "opt-1",
    targetRoot: root,
    items: [{ path: "demo.js", content: PATCHED, expectedSourceHash: sha256(ORIGINAL) }],
  })
  const m = readBackupManifest(sessionDir)!
  fs.rmSync(path.join(sessionDir, "backup", m.files[0]!.backupFile))
  const r = rollbackFromBackup({ sessionDir, manifest: m })
  assert.equal(r.ok, false)
  assert.ok(r.error?.includes("备份文件缺失"))
  assert.equal(fs.readFileSync(path.join(root, "demo.js"), "utf8"), PATCHED, "恢复失败不改动当前文件")
})
