/**
 * 对比：三种分析方式的效果差异
 *  A. 单文件入口（旧行为）：game-requirement-audit.js
 *  B. 目录模式（新）：整个 game-requirement-audit/ 目录
 *  C. 目录模式 + AI Rule Check
 */
import { analyzeWorkflow, createPlannerAgent } from "../../packages/tools/src/workflow-analyze-tool.js"

const CWD = "E:/WorkProjects/PrdGameSkill"
const DIR = ".opencode-workflows/workflows/game-requirement-audit"
const ENTRY = `${DIR}/game-requirement-audit.js`

function summarize(label: string, r: Awaited<ReturnType<typeof analyzeWorkflow>>) {
  const rep = r.report!
  const byRule: Record<string, number> = {}
  for (const f of rep.findings) byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1
  const files = new Set(rep.findings.map((f) => f.location.file).filter(Boolean))
  console.log(`\n===== ${label} =====`)
  console.log(`文件 ${rep.subtree?.files ?? 1} | 调用点 ${rep.executionEstimate.callSites} | findings ${rep.summary.totalFindings} | 分布文件 ${files.size}`)
  console.log(`入口风险 ${rep.summary.riskScore} | 聚合风险 ${rep.aggregateRiskScore ?? "-"}`)
  console.log(`规则命中: ${Object.entries(byRule).map(([k, v]) => `${k}×${v}`).join(" ") || "(无)"}`)
  if (rep.aiRuleCheck) {
    const rc = rep.aiRuleCheck
    console.log(`AI: ${rc.status} ${((rc.durationMs ?? 0) / 1000).toFixed(0)}s | ` +
      rc.checks.map((c) => `${c.ruleId}=${c.status}`).join(" "))
    console.log(`AI 独有命中: ${(rep.ruleMerge ?? []).filter((m) => m.finalStatus === "ai-hit").map((m) => m.ruleId).join(",") || "(无)"}`)
  }
}

const a = await analyzeWorkflow({ scriptPath: ENTRY, cwd: CWD, includeRuleCheck: false, format: "json" })
summarize("A 单文件入口（旧）", a)

const b = await analyzeWorkflow({ dirPath: DIR, cwd: CWD, includeRuleCheck: false, format: "json" })
summarize("B 目录模式（新，静态）", b)

const c = await analyzeWorkflow({
  dirPath: DIR,
  cwd: CWD,
  includeRuleCheck: true,
  ruleCheckAgent: createPlannerAgent({ cwd: CWD }),
  format: "json",
})
summarize("C 目录模式 + AI Rule Check", c)

// AI 逐条结论
if (c.report?.aiRuleCheck) {
  console.log("\n===== C 的 AI 逐条结论 =====")
  for (const ch of c.report.aiRuleCheck.checks) {
    console.log(`${ch.ruleId.padEnd(12)} ${ch.status.padEnd(12)} conf=${ch.confidence.toFixed(2)} ev=${ch.evidence.length}`)
    if (ch.status !== "pass" && ch.reason) console.log(`   ${ch.reason.slice(0, 260)}`)
  }
}
