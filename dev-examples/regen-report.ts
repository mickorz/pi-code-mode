import { analyzeWorkflow, createPlannerAgent } from "../src/tools/workflow-analyze-tool.js"
import { writeDashboard } from "../src/engine/analyzer/dashboard/build-dashboard.js"
import fs from "node:fs"

const CWD = "E:/WorkProjects/PrdGameSkill"
const DIR = ".opencode-workflows/workflows/game-requirement-audit"
const OUT = `${CWD}/.pi/workflows/reports`
fs.mkdirSync(OUT, { recursive: true })

const r = await analyzeWorkflow({
  dirPath: DIR,
  cwd: CWD,
  includeRuleCheck: true,
  ruleCheckAgent: createPlannerAgent({ cwd: CWD }),
  format: "md",
})
fs.writeFileSync(`${OUT}/game-requirement-audit.analysis.md`, r.rendered ?? "", "utf8")
fs.writeFileSync(`${OUT}/game-requirement-audit.analysis.json`, JSON.stringify(r.report, null, 2), "utf8")
const d = writeDashboard({
  report: r.report!,
  outDir: OUT,
  projectName: "game-requirement-audit",
  aiEnabled: true,
  aiSummary: r.planner?.analysisSummary,
})
console.log("md:", `${OUT}/game-requirement-audit.analysis.md`)
console.log("dashboard:", d.htmlPath, `(${(fs.statSync(d.htmlPath).size / 1024).toFixed(0)} KB)`)
console.log("findings:", r.report!.summary.totalFindings, "| AI:", r.report!.aiRuleCheck?.status, (r.report!.aiRuleCheck!.durationMs! / 1000).toFixed(0) + "s")
