/**
 * 验证结构化 HTML 报告：跑一次 optimize（会生成 optimize-report.html），检查渲染结果
 */
import fs from "node:fs"
import { optimizeSubcommand } from "../extensions/commands/workflows/optimize/index.js"
import { PiAgentAdapter } from "../src/adapter/pi-agent-adapter.js"
import { RunManager } from "../src/manager/run-manager.js"

const ROOT = "E:/WorkProjects/pi-code-mode/dev-examples/apply-e2e"
fs.rmSync(`${ROOT}/.pi`, { recursive: true, force: true })
const ctx: any = { cwd: ROOT, ui: { notify: () => {} }, hasUI: false }
const rm = new RunManager()
const deps: any = {
  runManager: rm,
  makeDeps: () => ({ runManager: rm, adapterFactory: () => new PiAgentAdapter({ defaultCwd: ROOT }), cwd: ROOT }),
  deliver: async () => {},
}
const t0 = Date.now()
await optimizeSubcommand.run([`${ROOT}/worker.js`, "--rules", "RETRY-001", "--fresh", "--no-open"], ctx, deps)
const runId = rm.list()[0]?.runId
while (Date.now() - t0 < 400_000) {
  await new Promise((r) => setTimeout(r, 5000))
  const st = rm.list()[0]
  if (st && st.status !== "running") break
}
const base = `${ROOT}/.pi/workflows/optimizations`
const id = fs.readdirSync(base).find((d) => d.startsWith("opt-"))!
const rpt = `${base}/${id}/optimize-report.html`
console.log(`\n报告存在：${fs.existsSync(rpt)} | 大小 ${fs.existsSync(rpt) ? fs.statSync(rpt).size : 0} B`)
if (fs.existsSync(rpt)) {
  const html = fs.readFileSync(rpt, "utf8")
  console.log("含表格:", html.includes("<table>"))
  console.log("含 KPI 卡片:", html.includes('class="kpi"'))
  console.log("含 diff 着色:", html.includes('class="add"') && html.includes('class="del"'))
  console.log("原始 markdown 残留（应为 false）:", html.includes("## 修改意图") || html.includes("| --- |"))
  console.log("报告路径:", rpt)
}
