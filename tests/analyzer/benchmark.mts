/**
 * M1-T8 Benchmark：Analyzer 检测准确率 / 误报率 / 漏报率 / 计划过期 / 旧 Workflow 兼容 / 确定性
 *
 * 人工标注样本（labeled expectations）：每个 fixture 声明「应检出哪些 rule、不应检出哪些 rule」。
 * 误报率 = 在「不应检出」标注上实际检出的比例；漏报率 = 在「应检出」标注上未检出的比例。
 *
 * 用法：npx tsx tests/analyzer/benchmark.mts [--json <outFile>]
 */
import fs from "node:fs"
import path from "node:path"

import { buildReport } from "../../src/engine/analyzer/report-builder.js"
import { hashScript } from "../../src/engine/plan/source-fingerprint.js"
import { loadPlan } from "../../src/engine/plan/plan-loader.js"

const FIX = path.join(import.meta.dirname, "fixtures")

interface Label {
  file: string
  /** 必须检出的 ruleId */
  expect: string[]
  /** 不得检出（误报检测） */
  forbid: string[]
  /** 该样本说明 */
  note?: string
}

/** 人工标注（T0 阶段建立的七类场景 + 真实脚本） */
const LABELS: Label[] = [
  { file: "atomic/serial-dependent.js", expect: ["SERIAL-001"], forbid: ["SERIAL-002"], note: "真串行不得给并行建议（关键误报项）" },
  { file: "atomic/serial-candidate.js", expect: ["SERIAL-002"], forbid: [], note: "相邻无引用 → 并行候选" },
  { file: "atomic/repeated-context.js", expect: ["INPUT-001"], forbid: [], note: "重复注入大对象" },
  { file: "atomic/parallel-waves.js", expect: [], forbid: [], note: "并行波次（任务数动态，允许无 CONC-001）" },
  { file: "atomic/dynamic-loop.js", expect: [], forbid: ["SERIAL-002"], note: "动态循环不得给并行建议" },
  { file: "atomic/dynamic-dispatch.js", expect: [], forbid: ["SERIAL-002"], note: "动态分发不得给并行建议" },
  // SERIAL-001 语义为「≥3 调用链」，2 调用子流程样本不应触发（避免与规则定义冲突）
  { file: "atomic/sub-workflow.js", expect: [], forbid: ["SERIAL-002"], note: "2 调用子流程：不足 3 链不报 SERIAL-001，且不得误报并行候选" },
  { file: "atomic/sub-workflow-chain.js", expect: ["SERIAL-001"], forbid: [], note: "3 个 workflow 子流程 Explicit 链" },
]

type Row = { file: string; expectHit: number; expectTotal: number; forbiddenHit: string[]; findings: number }

const rows: Row[] = []
for (const label of LABELS) {
  const abs = path.join(FIX, label.file)
  const src = fs.readFileSync(abs, "utf8")
  const report = buildReport({ source: src, file: label.file, generatedAt: "2026-11-18T00:00:00.000Z" })
  const ids = new Set(report.findings.map((f) => f.ruleId))
  const expectHit = label.expect.filter((r) => ids.has(r)).length
  const forbiddenHit = label.forbid.filter((r) => ids.has(r))
  rows.push({ file: label.file, expectHit, expectTotal: label.expect.length, forbiddenHit, findings: report.findings.length })
}

const expectTotal = rows.reduce((a, r) => a + r.expectTotal, 0)
const expectHit = rows.reduce((a, r) => a + r.expectHit, 0)
const forbidTotal = LABELS.reduce((a, l) => a + l.forbid.length, 0)
const forbidHit = rows.reduce((a, r) => a + r.forbiddenHit.length, 0)
const recall = expectTotal ? expectHit / expectTotal : 1
const falsePositiveRate = forbidTotal ? forbidHit / forbidTotal : 0

// 真实脚本：确定性 + 可分析性
const realDir = path.join(FIX, "real")
const realResults: Array<{ file: string; findings: number; deterministic: boolean; diagnostics: number; riskScore: number }> = []
for (const f of fs.readdirSync(realDir).filter((x) => x.endsWith(".js"))) {
  const src = fs.readFileSync(path.join(realDir, f), "utf8")
  const a = buildReport({ source: src, file: f, generatedAt: "T" })
  const b = buildReport({ source: src, file: f, generatedAt: "T" })
  realResults.push({
    file: f,
    findings: a.summary.totalFindings,
    deterministic: JSON.stringify(a) === JSON.stringify(b),
    diagnostics: a.diagnostics.length,
    riskScore: a.summary.riskScore,
  })
}

// Plan 过期检测：临时目录
const tmp = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "bench-plan-"))
const script = "export const meta = { name: 'bench' }\nawait agent('x')"
fs.writeFileSync(path.join(tmp, "bench.js"), script)
const plan = {
  planVersion: "1.0",
  source: { scriptPath: "bench.js", scriptHash: hashScript(script) },
  definition: { stages: [{ id: "a", type: "sequential" }], quality: { requiredValidation: true } },
  profiles: { balanced: {} },
}
fs.writeFileSync(path.join(tmp, "bench.js.plan.json"), JSON.stringify(plan))
const planFresh = loadPlan({ scriptPath: "bench.js", cwd: tmp })
fs.writeFileSync(path.join(tmp, "bench.js"), script + "\n// edited")
const planStale = loadPlan({ scriptPath: "bench.js", cwd: tmp })
const legacy = loadPlan({ scriptPath: "noplan.js", cwd: tmp })

const summary = {
  analyzerVersion: (await import("../../src/engine/analyzer/report-builder.js")).ANALYZER_VERSION,
  ruleSetVersion: (await import("../../src/engine/analyzer/report-builder.js")).RULE_SET_VERSION,
  generatedAt: new Date().toISOString(),
  detection: {
    labeledSamples: LABELS.length,
    expectTotal,
    expectHit,
    recall: +recall.toFixed(3),
    forbidTotal,
    forbidHit,
    falsePositiveRate: +falsePositiveRate.toFixed(3),
    perFile: rows.map((r, i) => ({ ...r, note: LABELS[i]!.note })),
  },
  realScripts: { count: realResults.length, allDeterministic: realResults.every((r) => r.deterministic), results: realResults },
  planLifecycle: { freshOk: planFresh.stale === false, staleDetected: planStale.stale === true, legacyWithoutPlan: legacy.plan === null },
}

const outIdx = process.argv.indexOf("--json")
const outFile = outIdx !== -1 ? process.argv[outIdx + 1] : path.join(import.meta.dirname, "..", "..", "dev-docs", "benchmark", "m1-analyzer-benchmark.json")
fs.mkdirSync(path.dirname(outFile!), { recursive: true })
fs.writeFileSync(outFile!, JSON.stringify(summary, null, 2))

console.log("== M1 Analyzer Benchmark ==")
console.log(`标注样本 ${LABELS.length} 个 | 应检出 ${expectTotal} 项 → 命中 ${expectHit}（recall ${(recall * 100).toFixed(1)}%）`)
console.log(`误报检测：应排除 ${forbidTotal} 项 → 误报 ${forbidHit} 项（FPR ${(falsePositiveRate * 100).toFixed(1)}%）`)
for (const r of rows) {
  const ok = r.expectHit === r.expectTotal && r.forbiddenHit.length === 0
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${r.file} expect ${r.expectHit}/${r.expectTotal}${r.forbiddenHit.length ? ` 误报=${r.forbiddenHit.join(",")}` : ""}`)
}
console.log(`\n真实脚本 ${realResults.length} 个：全部确定性=${summary.realScripts.allDeterministic}`)
for (const r of realResults) console.log(`  ${r.file}: findings=${r.findings} risk=${r.riskScore} diag=${r.diagnostics} deterministic=${r.deterministic}`)
console.log(`\nPlan 生命周期：fresh=${summary.planLifecycle.freshOk} stale=${summary.planLifecycle.staleDetected} legacy=${summary.planLifecycle.legacyWithoutPlan}`)
console.log(`\n报告：${outFile}`)

const pass =
  recall === 1 &&
  falsePositiveRate === 0 &&
  summary.realScripts.allDeterministic &&
  summary.planLifecycle.freshOk &&
  summary.planLifecycle.staleDetected &&
  summary.planLifecycle.legacyWithoutPlan
process.exit(pass ? 0 : 1)
