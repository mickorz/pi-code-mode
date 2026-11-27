// M2-W4 审计落盘 contract 测试
// 覆盖：按日分文件 / append-only / 并发不交错 / 只记事实不含输出 / 写失败不阻断
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  AUDIT_DIR,
  ControlPlaneAuditWriter,
  auditFileName,
  type ControlPlaneAuditEvent,
} from "../../packages/execution/src/index.js"

const evt = (over: Partial<ControlPlaneAuditEvent> = {}): ControlPlaneAuditEvent => ({
  at: Date.now(),
  command: "cocoscli build web-mobile",
  cwd: "E:/proj",
  rule: "GUI 构建链",
  decision: "approved",
  exitCode: 0,
  durationMs: 111000,
  runId: "run-1",
  executionId: "exec-1",
  ...over,
})

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pcm-audit-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("AUD-01 按日分文件，落目录 .pi/workflows/audit", async () => {
  await withTmp(async (dir) => {
    const w = new ControlPlaneAuditWriter(dir)
    await w.write(evt())
    const files = await readdir(path.join(dir, AUDIT_DIR))
    assert.equal(files.length, 1)
    assert.equal(files[0], auditFileName())
    assert.match(files[0], /^control-plane-\d{4}-\d{2}-\d{2}\.jsonl$/)
  })
})

test("AUD-02 append-only：多次写入逐行追加，不覆盖", async () => {
  await withTmp(async (dir) => {
    const w = new ControlPlaneAuditWriter(dir)
    await w.write(evt({ command: "cmd-a" }))
    await w.write(evt({ command: "cmd-b", decision: "denied", denyReason: "not_approved" }))
    await w.flush()
    const text = await readFile(path.join(dir, AUDIT_DIR, auditFileName()), "utf8")
    const lines = text.split("\n").filter(Boolean)
    assert.equal(lines.length, 2)
    const [a, b] = lines.map((l) => JSON.parse(l))
    assert.equal(a.command, "cmd-a")
    assert.equal(a.kind, "control-plane")
    assert.equal(b.decision, "denied")
    assert.equal(b.denyReason, "not_approved")
    assert.equal(typeof a.ts, "string", "含 ISO 时间戳")
  })
})

test("AUD-03 并发写入不交错（串行化写队列）", async () => {
  await withTmp(async (dir) => {
    const w = new ControlPlaneAuditWriter(dir)
    // 50 条并发写入：每行必须是完整合法 JSON
    await Promise.all(Array.from({ length: 50 }, (_, i) => w.write(evt({ command: `cmd-${i}` }))))
    await w.flush()
    const text = await readFile(path.join(dir, AUDIT_DIR, auditFileName()), "utf8")
    const lines = text.split("\n").filter(Boolean)
    assert.equal(lines.length, 50)
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), "每行必须是完整 JSON")
    }
    const cmds = new Set(lines.map((l) => JSON.parse(l).command))
    assert.equal(cmds.size, 50, "50 条全部落盘且不重复")
  })
})

test("AUD-04 只记事实：审计记录不含命令输出内容", async () => {
  await withTmp(async (dir) => {
    const w = new ControlPlaneAuditWriter(dir)
    // 事件结构本身没有 stdout/stderr 字段；这里断言最终落盘文本也不含
    await w.write(evt())
    await w.flush()
    const text = await readFile(path.join(dir, AUDIT_DIR, auditFileName()), "utf8")
    assert.ok(!text.includes("stdout"))
    assert.ok(!text.includes("stderr"))
    assert.ok(text.includes("cocoscli build web-mobile"), "命令文本本身可记（事实）")
  })
})

test("AUD-05 写失败不阻断：目录不可写时只警告一次，write 不 reject", async () => {
  await withTmp(async (dir) => {
    // 用一个文件占住 .pi 位置，使 mkdir 失败
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path.join(dir, ".pi"), "not-a-dir", "utf8")
    const warnings: string[] = []
    const w = new ControlPlaneAuditWriter(dir, (m) => warnings.push(m))
    await assert.doesNotReject(() => w.write(evt()))
    await assert.doesNotReject(() => w.write(evt()))
    await w.flush()
    assert.equal(warnings.length, 1, "同类失败只警告一次（避免刷屏）")
    assert.match(warnings[0], /审计落盘失败/)
  })
})
