/**
 * M2 Benchmark：预算三分类拦截率 / Plan 注入兼容性 / 指标完整性
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { BudgetGate } from "../../src/engine/governance/budget-gate.js"
import { BudgetTracker } from "../../src/engine/governance/budget-tracker.js"
import { resolvePlanContext } from "../../src/engine/plan/plan-runner.js"
import { hashScript } from "../../src/engine/plan/source-fingerprint.js"
import { runWorkflow } from "../../src/engine/runtime/workflow-runtime.js"

const results: Array<{ name: string; pass: boolean; detail: string }> = []
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail })
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m2bench-"))
const runner = (n = { c: 0 }: any) => ({
  async run() {
    n.c++
    return { type: "text", value: "ok", sessionId: `s${n.c}` }
  },
  async cancel() {},
})

// 1) 三类硬预算拦截率 100%
const cases: Array<[string, () => Promise<boolean>]> = [
  [
    "maxAgents",
    async () => {
      const g = new BudgetGate({ runId: "b1", limits: { maxAgents: 1 }, activeProfile: "balanced", initialPolicy: {}, requiredValidation: true })
      const s = `export const meta = { name: 'b1' }\nawait agent('a')\nawait agent('b')\nreturn 1`
      try {
        await runWorkflow(s, { agent: runner() as any, cwd: tmp(), budgetGate: g, agentRetries: 0 })
        return false
      } catch (e) {
        return /预算拦截|上限/.test(String(e))
      }
    },
  ],
  [
    "maxDurationMs",
    async () => {
      const t = new BudgetTracker({ runId: "b2", limits: { maxDurationMs: 1 }, startedAt: Date.now() - 1000 })
      return t.canDispatch()?.action === "stop"
    },
  ],
  [
    "maxRetries",
    async () => {
      const t = new BudgetTracker({ runId: "b3", limits: { maxRetries: 0 } })
      return t.recordRetry()?.kind === "hard-retries"
    },
  ],
]
for (const [name, fn] of cases) {
  const pass = await fn()
  check(`硬预算 ${name} 拦截`, pass)
}

// 2) 软预算预留并发安全（5 并发各 3000 / 上限 10000 → 只能 3 个）
{
  const t = new BudgetTracker({ runId: "soft", limits: { maxInputTokens: 10000 } })
  const ok = [1, 2, 3, 4, 5].map(() => t.reserve({ estimatedInputTokens: 3000 })).filter(Boolean).length
  check("软预算并发预留不超发", ok === 3, `成功 ${ok}/5`)
}

// 3) Plan 注入兼容性：无 Plan 行为不变
{
  const d = tmp()
  const r = await runWorkflow(`export const meta = { name: 'noplan' }\nawait agent('a')\nreturn 'ok'`, { agent: runner() as any, cwd: d })
  check("无 Plan 零改动兼容", r.result === "ok")
}

// 4) Plan 注入生效
{
  const d = tmp()
  const script = "export const meta = { name: 'withplan' }\nawait agent('a')\nreturn 'ok'"
  fs.writeFileSync(path.join(d, "w.js"), script)
  fs.writeFileSync(
    path.join(d, "w.js.plan.json"),
    JSON.stringify({
      planVersion: "1.0",
      source: { scriptPath: "w.js", scriptHash: hashScript(script) },
      definition: { stages: [{ id: "s", type: "sequential" }], quality: { requiredValidation: true } },
      profiles: { balanced: { mode: "balanced", concurrency: { max: 3 }, budget: { maxAgents: 10 } } },
    }),
  )
  const ctx = resolvePlanContext({ scriptPath: "w.js", cwd: d, runId: "p1" })
  check("Plan 解析注入 budget/concurrency", Boolean(ctx) && ctx!.concurrency === 3)
}

// 5) 指标完整性：聚合与逐条 usage 一致
{
  const t = new BudgetTracker({ runId: "agg" })
  const usages = [{ input: 10, output: 5 }, { input: 20, output: 7 }, { input: 30, output: 3 }]
  for (const u of usages) t.recordUsage(u)
  const sum = usages.reduce((a, u) => a + u.input, 0)
  check("指标聚合 = 逐条之和", t.totals().inputTokens === sum, `${t.totals().inputTokens} vs ${sum}`)
}

const pass = results.every((r) => r.pass)
const out = { generatedAt: new Date().toISOString(), results, allPass: pass }
const outFile = path.join(import.meta.dirname, "..", "..", "dev-docs", "benchmark", "m2-budget-benchmark.json")
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, JSON.stringify(out, null, 2))
console.log("== M2 Benchmark ==")
for (const r of results) console.log(`  [${r.pass ? "PASS" : "FAIL"}] ${r.name}${r.detail ? ` (${r.detail})` : ""}`)
console.log(`\n报告：${outFile}`)
process.exit(pass ? 0 : 1)
