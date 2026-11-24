/**
 * 最小 workflow 实测驱动：anal → run → status
 *
 * 直接调子命令实现（与 /workflows 路由走同一对象），验证命令行链路而非绕过。
 */
import { analyzeSubcommand } from "../apps/plugin/extensions/commands/workflows/analyze.js"
import { runSubcommand } from "../apps/plugin/extensions/commands/workflows/run.js"
import { statusSubcommand } from "../apps/plugin/extensions/commands/workflows/status.js"
import { PiAgentAdapter } from "../packages/adapter/src/pi-agent-adapter.js"
import { RunManager } from "../packages/manager/src/run-manager.js"
import type { WorkflowsCommandDeps } from "../apps/plugin/extensions/commands/workflows/types.js"

const notes: Array<{ text: string; level: string }> = []
const ctx: any = {
  cwd: process.cwd(),
  ui: { notify: (text: string, level: string) => notes.push({ text, level }) },
  hasUI: false,
}

const runManager = new RunManager()
const deps: WorkflowsCommandDeps = {
  runManager,
  makeDeps: () => ({
    runManager,
    adapterFactory: () => new PiAgentAdapter({ defaultCwd: process.cwd() }),
    cwd: process.cwd(),
  }) as any,
  deliver: async (text: string) => {
    notes.push({ text: `[deliver] ${text}`, level: "info" })
  },
}

const drain = (label: string) => {
  console.log(`\n===== ${label} =====`)
  for (const n of notes) console.log(`[${n.level}] ${n.text}`)
  notes.length = 0
}

// ① anal（静态，无 AI 规则检查以缩短耗时）
await analyzeSubcommand.run(["dev-examples/min-workflow/demo.js", "--no-rule-check", "--no-open"], ctx, deps)
drain("① /workflows anal")

// ② run（后台）
await runSubcommand.run(["dev-examples/min-workflow/demo.js", "who=世界"], ctx, deps)
drain("② /workflows run")

// ③ 等 run 完成再查 status
const runIdMatch = (() => {
  const merged = ""
  void merged
  return null
})()
void runIdMatch
await new Promise((r) => setTimeout(r, 20000))
const runs = runManager.list()
console.log("\n===== ③ /workflows status =====")
if (runs.length === 0) {
  console.log("(没有 run 记录)")
} else {
  for (const r of runs) {
    await statusSubcommand.run([r.runId], ctx, deps)
    drain(`status ${r.runId}`)
  }
}
process.exit(0)
