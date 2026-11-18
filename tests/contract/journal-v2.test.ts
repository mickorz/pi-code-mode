/**
 * Journal V2 兼容测试（M5）：Explorer 详情层读 Journal，但绝不能改变回放语义。
 *
 * 断言：
 *  - V1 文件（无 metadata/observability）照常读，load() 的 hash/result 不变
 *  - recordRunSummary 只补 metadata/observability，entries 原样（hash/result 不变）
 *  - 老文件无需迁移即可被 Explorer 读取（metadata 缺失 = undefined）
 *  - 损坏文件降级为空 journal，不抛错
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { JournalStore } from "../../src/engine/persistence/journal.js"
import { JournalDetailRepository } from "../../src/explorer/repository/detail-repository.js"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "journal-v2-"))
}

const ENTRY = {
  hash: "hash-abc",
  result: { answer: 42 },
  model: "provider/model",
  label: "AgentA",
  phase: "实现",
  prompt: "原始 prompt 文本",
  outputType: "structured" as const,
  startedAt: 1700000000000,
  durationMs: 1234,
  usage: { inputTokens: 10, outputTokens: 5 },
  executions: [{ executionId: "r1:0:t1", attempt: 1, status: "ok" as const, startedAt: 1, durationMs: 900 }],
}

test("Journal V2: V1 老文件照常读（metadata/observability 缺省）", () => {
  const dir = tmpDir()
  const store = new JournalStore(dir, path.join(dir, "journal"))
  store.append("r1", "r1:0", ENTRY)

  const raw = JSON.parse(fs.readFileSync(path.join(dir, "journal", "r1.json"), "utf8"))
  assert.equal(raw.version, 1, "append 不改版本号")

  const reloaded = new JournalStore(dir, path.join(dir, "journal"))
  const entries = reloaded.load("r1")
  assert.equal(entries.get("r1:0")!.hash, "hash-abc", "hash 不变（回放命中依据）")
  assert.deepEqual(entries.get("r1:0")!.result, { answer: 42 })
  assert.equal(reloaded.getRunMetadata("r1"), undefined, "V1 无元数据")
  assert.equal(reloaded.getObservability("r1"), undefined)
})

test("Journal V2: recordRunSummary 只加观测字段，entries（hash/result）逐一不变", () => {
  const dir = tmpDir()
  const jdir = path.join(dir, "journal")
  const store = new JournalStore(dir, jdir)
  store.append("r1", "r1:0", ENTRY)
  store.append("r1", "r1:1", { ...ENTRY, hash: "hash-def", result: "text-result" })

  const before = new Map(store.load("r1"))
  store.recordRunSummary("r1", {
    metadata: { workflowName: "root_flow", status: "completed", endedAt: 1700000009999 },
    observability: { lastSequence: 12, workflows: [{ scopePath: ["root"] }] },
  })

  // 重新从磁盘读（验证落盘而不是只改内存）
  const fresh = new JournalStore(dir, jdir)
  const after = fresh.load("r1")
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), "entries 键集合不变")
  for (const [key, entry] of before) {
    assert.equal(after.get(key)!.hash, entry.hash, `${key} 的 hash 不变`)
    assert.deepEqual(after.get(key)!.result, entry.result, `${key} 的 result 不变`)
  }
  const raw = JSON.parse(fs.readFileSync(path.join(jdir, "r1.json"), "utf8"))
  assert.equal(raw.version, 2)
  assert.equal(raw.metadata.workflowName, "root_flow")
  assert.equal(raw.observability.lastSequence, 12)
})

test("Journal V2: DetailRepository 按 agentId 取详情（agentId 即 journal key）", () => {
  const dir = tmpDir()
  const jdir = path.join(dir, "journal")
  const store = new JournalStore(dir, jdir)
  store.append("r1", "r1:0", ENTRY)
  store.recordExecution("r1", "r1:1", {
    executionId: "r1:1:t1",
    attempt: 1,
    status: "failed",
    label: "AgentB",
    error: "boom",
    startedAt: 1,
    durationMs: 50,
  })

  const repo = new JournalDetailRepository(store, "r1")
  const detail = repo.getAgentDetail("r1:0")!
  assert.equal(detail.prompt, "原始 prompt 文本")
  assert.equal(detail.model, "provider/model")
  assert.equal(detail.inputTokens, 10)
  assert.equal(detail.executions.length, 1)

  const failed = repo.getAgentDetail("r1:1")!
  assert.equal(failed.executions[0].status, "failed")
  assert.equal(failed.result, undefined, "失败 attempt 不写 result")

  assert.equal(repo.getAgentDetail("r1:404"), undefined, "未知节点返回 undefined 而不是抛错")
})

test("Journal V2: 损坏文件降级为空 journal（不抛错）", () => {
  const dir = tmpDir()
  const jdir = path.join(dir, "journal")
  fs.mkdirSync(jdir, { recursive: true })
  fs.writeFileSync(path.join(jdir, "bad.json"), "{not json", "utf8")
  const store = new JournalStore(dir, jdir)
  assert.equal(store.load("bad").size, 0)
  assert.equal(store.getRunMetadata("bad"), undefined)
})

test("Journal V2: 原子写入后无残留 tmp 文件", () => {
  const dir = tmpDir()
  const jdir = path.join(dir, "journal")
  const store = new JournalStore(dir, jdir)
  store.append("r1", "r1:0", ENTRY)
  store.recordRunSummary("r1", { metadata: { status: "completed" } })
  const files = fs.readdirSync(jdir)
  assert.ok(files.includes("r1.json"))
  assert.ok(!files.some((f) => f.endsWith(".tmp")), "无残留 tmp")
})
