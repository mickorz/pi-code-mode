/**
 * 缺陷 demo 的 anal 实测：验证规则召回
 * 用法：npx tsx dev-examples/buggy-anal.ts [--with-ai]
 */
import { analyzeSubcommand } from "../extensions/commands/workflows/analyze.js"
import { analyzeWorkflow } from "../src/tools/workflow-analyze-tool.js"

const TARGET = "dev-examples/min-workflow/buggy-demo.js"
const withAi = process.argv.includes("--with-ai")

// ① 直接用 analyzeWorkflow 拿结构化结果（便于逐条核对规则）
const r = await analyzeWorkflow({ scriptPath: TARGET, cwd: process.cwd(), includeRuleCheck: false, format: "json" })
if (!r.ok || !r.report) {
  console.error("分析失败：", r.error)
  process.exit(1)
}
const rep = r.report
console.log("=== 静态规则命中（14 条全量）===")
for (const x of rep.ruleInventory) {
  const mark = x.hits > 0 ? `命中 ${x.hits}` : x.status === "ai-only" ? "ai-only" : "通过"
  console.log(`  ${x.id.padEnd(12)} ${mark}`)
}
console.log(`\n风险分 ${rep.summary.riskScore}/100 | findings ${rep.summary.totalFindings} | 问题簇 ${(rep.clusters ?? []).length}`)
console.log("\n=== 问题簇明细 ===")
for (const c of rep.clusters ?? []) {
  console.log(`  ${c.ruleId} ×${c.count} | ${c.severity} | conf=${c.confidence.toFixed(2)} | ${c.locations.slice(0, 2).join(" ")}`)
  if (c.evidence[0]) console.log(`     ${c.evidence[0].slice(0, 140)}`)
}

// ② 走命令链路（看用户实际看到什么）
const notes: Array<{ text: string; level: string }> = []
const ctx: any = { cwd: process.cwd(), ui: { notify: (t: string, l: string) => notes.push({ text: t, level: l }) } }
await analyzeSubcommand.run(
  [TARGET, "--no-open", ...(withAi ? [] : ["--no-rule-check", "--no-suggest"])],
  ctx,
  {} as never,
)
console.log("\n=== /workflows anal 输出 ===")
console.log(notes.at(-1)?.text ?? "(无输出)")
