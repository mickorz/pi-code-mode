/**
 * apply / rollback 真实端到端验证
 *
 * 目标链路：optimize（生成补丁）→ benchmark（真执行 + verifier）→ ready → apply → rollback
 *
 * 用真实 workflow（dev-examples/apply-e2e/worker.js，故意带 RETRY-001，~20s 一轮）
 * 直接调子命令（与 /workflows optimize 路由同一对象）。
 */
import fs from "node:fs"
import path from "node:path"

import { optimizeSubcommand } from "../apps/plugin/extensions/commands/workflows/optimize/index.js"
import { PiAgentAdapter } from "../packages/adapter/src/pi-agent-adapter.js"
import { RunManager } from "../packages/manager/src/run-manager.js"
import { readSession, sessionPaths } from "../packages/engine/src/optimizer/session-store.js"
import { sha256 } from "../packages/engine/src/optimizer/target-resolver.js"
import type { WorkflowsCommandDeps } from "../apps/plugin/extensions/commands/workflows/types.js"

const ROOT = "E:/WorkProjects/pi-code-mode/dev-examples/apply-e2e"
const TARGET = `${ROOT}/worker.js`

const notes: Array<{ text: string; level: string }> = []
const ctx: any = {
  cwd: ROOT,
  ui: { notify: (text: string, level: string) => notes.push({ text, level }) },
  hasUI: false,
}

const runManager = new RunManager()
const deps: WorkflowsCommandDeps = {
  runManager,
  makeDeps: () => ({
    runManager,
    adapterFactory: () => new PiAgentAdapter({ defaultCwd: ROOT }),
    cwd: ROOT,
  }) as any,
  deliver: async (text: string) => notes.push({ text: `[deliver] ${text.slice(0, 400)}`, level: "info" }),
}

const drain = (label: string, all = false) => {
  console.log(`\n===== ${label} =====`)
  const items = all ? notes : notes.slice(-1)
  for (const n of items) console.log(`[${n.level}] ${n.text}`)
  notes.length = 0
}

const original = fs.readFileSync(TARGET, "utf8")
const originalHash = sha256(original)
console.log(`原文件：${TARGET}`)
console.log(`原 hash：${originalHash}`)
console.log(`含 retries: 2 → ${/retries:\s*2/.test(original)}`)

// 清理历史会话，保证 --fresh 语义
const sessDir = path.join(ROOT, ".pi", "workflows", "optimizations")
fs.rmSync(sessDir, { recursive: true, force: true })

// ---- ① optimize：生成候选 ----
await optimizeSubcommand.run([TARGET, "--rules", "RETRY-001", "--fresh"], ctx, deps)
drain("① optimize（生成候选）")

// 找到会话 id
const ids = fs.existsSync(sessDir) ? fs.readdirSync(sessDir).filter((d) => d.startsWith("opt-")) : []
if (ids.length === 0) {
  console.log("\n[中止] 没有生成会话目录")
  process.exit(1)
}
const id = ids[0]!
let s = readSession(ROOT, id)
console.log(`\n会话：${id} | 状态：${s?.status}`)
if (s?.status !== "benchmark-pending") {
  console.log(`[中止] 期望 benchmark-pending，实际 ${s?.status}（补丁未生成或已被拒）`)
  process.exit(1)
}

// ---- ② benchmark：真执行 before/after + verifier ----
await optimizeSubcommand.run([TARGET, "--benchmark", "--args", String.raw`{"n":1}`, "--verify-cmd", "node verify.mjs"], ctx, deps)
drain("② benchmark（真执行 + verifier）", true)

s = readSession(ROOT, id)
console.log(`\n状态：${s?.status} | validation=${JSON.stringify(s?.validation)}`)

// ---- ③ apply ----
if (s?.status === "ready") {
  await optimizeSubcommand.run(["apply", id], ctx, deps)
  drain("③ apply")
  const after = fs.readFileSync(TARGET, "utf8")
  console.log(`\napply 后 hash：${sha256(after)}（原 ${originalHash}）`)
  console.log(`已修改：${sha256(after) !== originalHash}（期望 true）`)
  console.log(`session：${readSession(ROOT, id)?.status}`)

  // ---- ④ rollback ----
  await optimizeSubcommand.run(["rollback", id], ctx, deps)
  drain("④ rollback")
  const back = fs.readFileSync(TARGET, "utf8")
  console.log(`\nrollback 后 hash：${sha256(back)}`)
  console.log(`已还原：${sha256(back) === originalHash}（期望 true）`)
  console.log(`session：${readSession(ROOT, id)?.status}`)
} else {
  console.log("\n[跳过 apply] 状态不是 ready，看看 benchmark.md")
  const bm = sessionPaths(ROOT, id).dir + "/benchmark.md"
  if (fs.existsSync(bm)) console.log(fs.readFileSync(bm, "utf8").slice(0, 1500))
  process.exit(1)
}
process.exit(0)
