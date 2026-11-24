// Replay Policy 三类回放契约测试（R3 §5.2，M2 交付；零 LLM，fake runner + journal）
//
// 三类用例：
//   1. 纯读取节点（显式 replayable: true）-> resume 复用（fake runner 不再调用）
//   2. 文件写入节点（默认无 replayable）-> explicit 模式下一律重跑（副作用安全）
//   3. 跨 Scope 节点（child 内 replayable）-> child scope 的 firstMiss 独立，可复用
//
// 对照：prefix 模式（M1 基线语义）不受 replayable 影响——191 基线测试已覆盖，此处加对照断言。
// 跑法: npx tsx --test replay-policy.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runWorkflow } from "../../packages/engine/src/runtime/workflow-runtime.js"
import type { AgentSessionRunner, AgentExecutionResult } from "../../packages/engine/src/agent/session-runner.js"

function makeRunner(): { runner: AgentSessionRunner; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    runner: {
      async run(prompt: string): Promise<AgentExecutionResult> {
        calls.push(prompt)
        return { type: "text", value: `ok:${prompt.slice(0, 12)}`, sessionId: "fake" }
      },
    },
  }
}

/** 跑脚本并收集 journal（resume 用）；opts.cwd 优先 */
async function run(script: string, opts: Record<string, unknown>, agent: AgentSessionRunner) {
  const journalMap = new Map<string, any>()
  const result = await runWorkflow(script, {
    agent,
    onAgentJournal: (entry: any) => journalMap.set(entry.key, entry),
    ...opts,
    cwd: (opts.cwd as string) ?? process.cwd(),
  })
  return { result, journalMap }
}

const SCRIPT = `export const meta = { name: 'rp', description: 'd' }
const a = await agent('纯读取节点', { replayable: true, label: 'A' })
const b = await agent('写入节点默认重跑', { label: 'B' })
return { a, b }`

test("Replay: explicit 模式下 replayable 节点复用、默认节点重跑", async () => {
  const first = makeRunner()
  const { journalMap } = await run(SCRIPT, { replayPolicy: "explicit", runId: "rp-1" }, first.runner)
  assert.equal(first.calls.length, 2)

  const second = makeRunner()
  await run(SCRIPT, { replayPolicy: "explicit", resumeJournal: journalMap, runId: "rp-1" }, second.runner)
  // A（replayable）复用不出现在 calls；B（默认 rerun）重跑
  assert.deepEqual(second.calls, ["写入节点默认重跑"])
})

test("Replay: prefix 模式（缺省）不受 replayable 影响，基线语义保持", async () => {
  const first = makeRunner()
  const { journalMap } = await run(SCRIPT, { runId: "rp-2" }, first.runner)
  assert.equal(first.calls.length, 2)

  const second = makeRunner()
  await run(SCRIPT, { resumeJournal: journalMap, runId: "rp-2" }, second.runner)
  assert.equal(second.calls.length, 0, "prefix 模式 hash 命中即回放（M1 基线语义）")
})

test("Replay: explicit 模式下 prompt 变更 -> 前缀截断（含 replayable 节点失效）", async () => {
  const first = makeRunner()
  const { journalMap } = await run(SCRIPT, { replayPolicy: "explicit", runId: "rp-1" }, first.runner)
  assert.equal(first.calls.length, 2)

  // A 的 prompt 变了：hash 不匹配 -> firstMiss=0 -> B 虽然 hash 命中但不在前缀内，重跑
  const changed = SCRIPT.replace("'纯读取节点'", "'纯读取节点(改动版)'")
  const second = makeRunner()
  await run(changed, { replayPolicy: "explicit", resumeJournal: journalMap, runId: "rp-1" }, second.runner)
  assert.equal(second.calls.length, 2, "上游变更后前缀截断，replayable 节点也重跑")
})

test("Replay: 跨 Scope——parent 默认节点重跑，child 内 replayable 节点独立复用", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-scope-"))
  const childPath = path.join(dir, "child.js")
  fs.writeFileSync(
    childPath,
    `export const meta = { name: 'rp_child', description: 'd' }\n` +
      `const x = await agent('child 纯读取', { replayable: true })\n` +
      `return { x }`,
  )
  const parent = `export const meta = { name: 'rp_parent', description: 'd' }\n` +
    `const p = await agent('parent 默认节点', { label: 'P' })\n` +
    `return await workflow('./child.js')`

  const first = makeRunner()
  const { journalMap } = await run(parent, { replayPolicy: "explicit", cwd: dir, runId: "rp-3" }, first.runner)
  assert.equal(first.calls.length, 2) // parent + child 各 1

  const second = makeRunner()
  await run(parent, { replayPolicy: "explicit", resumeJournal: journalMap, cwd: dir, runId: "rp-3" }, second.runner)
  // parent 默认节点重跑；child 是独立 scope（firstMiss 私有），replayable 节点复用
  assert.deepEqual(second.calls, ["parent 默认节点"])
})
