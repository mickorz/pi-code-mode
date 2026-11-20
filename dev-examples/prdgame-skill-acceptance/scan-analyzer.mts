/**
 * PrdGameSkill 真实场景验收：Analyzer 全量扫描
 *
 * 目的：用真实生产 workflow 验证 Analyzer 是否产出有意义的风险与估算，
 * 而不是只在小 fixture 上通过。
 *
 * 用法：npx tsx dev-examples/prdgame-skill-acceptance/scan-analyzer.mts
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { buildReport } from "../../src/engine/analyzer/report-builder.js"

const ROOT = path.resolve("thirdparties/PrdGameSkill/.opencode-workflows/workflows")

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collect(full, out)
    else if (entry.name.endsWith(".js")) out.push(full)
  }
  return out
}

const files = collect(ROOT).sort()
const rows: Array<{ file: string; risk: number; calls: number; waves?: number; dynamic: number; findings: string; top: string }> = []

for (const abs of files) {
  const source = fs.readFileSync(abs, "utf8")
  const report = buildReport({ source, file: path.relative(ROOT, abs), generatedAt: "T" })
  const e = report.executionEstimate
  const counts: Record<string, number> = {}
  for (const f of report.findings) counts[f.ruleId] = (counts[f.ruleId] ?? 0) + 1
  rows.push({
    file: path.relative(ROOT, abs),
    risk: report.summary.riskScore,
    calls: e.callSites,
    ...(e.estimatedWaves !== undefined ? { waves: e.estimatedWaves } : {}),
    dynamic: e.dynamicNodes,
    findings: Object.entries(counts)
      .map(([k, v]) => `${k}x${v}`)
      .join(","),
    top: report.findings[0]?.ruleId ?? "-",
  })
}

rows.sort((a, b) => b.risk - a.risk)

console.log(`== PrdGameSkill Analyzer 扫描（${rows.length} 个真实 workflow）==\n`)
console.log("risk | calls | waves | dyn | 脚本 | findings")
for (const r of rows) {
  console.log(
    `${String(r.risk).padStart(4)} | ${String(r.calls).padStart(5)} | ${String(r.waves ?? "-").padStart(5)} | ${String(r.dynamic).padStart(3)} | ${r.file} | ${r.findings || "-"}`,
  )
}

const withRisk = rows.filter((r) => r.risk > 0).length
const withDynamic = rows.filter((r) => r.dynamic > 0).length
const summary = {
  total: rows.length,
  withFindings: withRisk,
  withDynamic,
  avgRisk: Math.round(rows.reduce((a, r) => a + r.risk, 0) / Math.max(1, rows.length)),
  rows,
}

const outDir = path.join(import.meta.dirname, "results")
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, "analyzer-scan.json")
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2))
console.log(`\n${withRisk}/${rows.length} 个脚本有 finding；${withDynamic} 个含动态节点；平均风险分 ${summary.avgRisk}`)
console.log(`结果：${outFile}`)
void os
