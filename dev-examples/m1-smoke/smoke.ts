// M1 冒烟：PiAgentAdapter -> agentAdapterToRunner -> runWorkflow 端到端（真实模型）
// 验证点：脚本执行、journal 落盘、结果渲染；对应 P0-A 的最小前置
// 用法: npx tsx smoke.ts
import fs from "node:fs"
import path from "node:path"
import { PiAgentAdapter } from "../../packages/adapter/src/pi-agent-adapter.js"
import { agentAdapterToRunner } from "../../packages/adapter/src/agent-adapter.js"
import { runWorkflow } from "../../packages/engine/src/runtime/workflow-runtime.js"
import { JournalStore } from "../../packages/engine/src/persistence/journal.js"
import { renderWorkflowRunResult } from "../../packages/tools/src/render-text.js"

const cwd = path.resolve(import.meta.dirname ?? ".", "../..")
const script = `export const meta = { name: 'm1_smoke', description: 'M1 冒烟: 1 发现 + 2 并行' }

phase('Scan')
const info = await agent('列出你当前目录下的文件名，只输出前 5 个，一行一个', { label: '发现' })

phase('Echo')
const results = await parallel([
  () => agent('用一句话说明什么是工作流编排', { label: 'echo-1' }),
  () => agent('用一句话说明什么是确定性重放', { label: 'echo-2' }),
])
return { info, results }`

console.log("[m1-smoke] 开始（真实模型调用，预计 30-60s）...")
const t0 = Date.now()
const runId = `run-m1smoke-${Date.now()}`
const journal = new JournalStore(cwd, path.join(cwd, ".pi", "workflows", "journal"))
const outcome = await runWorkflow(script, {
  agent: agentAdapterToRunner(new PiAgentAdapter({ defaultCwd: cwd })),
  cwd,
  runId,
  onAgentJournal: (entry) => journal.append(runId, entry.key, entry),
})
const elapsed = Date.now() - t0

console.log(renderWorkflowRunResult(outcome, { runId: outcome.runId, sourceLabel: "m1-smoke" }))

// journal 落盘验证
const journalDir = path.join(cwd, ".pi/workflows/journal")
const files = fs.existsSync(journalDir) ? fs.readdirSync(journalDir) : []
console.log("\n[journal] 目录内容:", files.length ? files.join(", ") : "(空)")

const ok =
  outcome.agentCount === 3 &&
  outcome.agents.every((a) => a.status === "ok") &&
  outcome.result &&
  typeof outcome.result.info === "string" &&
  Array.isArray(outcome.result.results) &&
  outcome.result.results.length === 2

console.log(`\n[m1-smoke] ${ok ? "PASS" : "FAIL"} (${elapsed}ms)`)
process.exit(ok ? 0 : 1)
