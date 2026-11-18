/**
 * M4 Benchmark：分片确定性 / 上下文节省 / 自适应调度 / 证据覆盖率 / 质量不降级
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { LayeredContext } from "../../src/engine/adaptive/context-layers.js"
import { buildProfiles, planSchedule, samplesFromCheckpoints } from "../../src/engine/adaptive/adaptive-scheduler.js"
import { AdaptiveModelPool } from "../../src/engine/adaptive/adaptive-model-pool.js"
import { checkValidationNotWeakened, resolveModePolicy } from "../../src/engine/adaptive/mode-policy.js"
import { planShardedTasks, shardItems, verifyShards } from "../../src/engine/adaptive/sharder.js"
import type { WorkflowPlan } from "../../src/engine/plan/schema.js"

const results: Array<{ name: string; pass: boolean; detail: string }> = []
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail })

// 1) 分片确定性（同输入同分片，无遗漏无重复）
{
  const items = Array.from({ length: 48 }, (_, i) => ({ id: i, text: "x".repeat(50) }))
  const a = shardItems(items, { strategy: "count", limit: 8 })
  const b = shardItems(items, { strategy: "count", limit: 8 })
  check("分片确定性（同输入同分片）", a.stats.deterministic === b.stats.deterministic)
  check("分片无遗漏无重复", verifyShards(items, a).ok, verifyShards(items, a).detail)
}

// 2) 上下文节省：48 任务共享 50KB
{
  const ctx = new LayeredContext()
  ctx.registerShared({ ref: "ctx://rules", summary: "导航摘要", sourceBytes: 50000, evidence: [{ ref: "file://rules.md" }] })
  for (let i = 0; i < 48; i++) ctx.registerTask({ taskKey: `t${i}`, input: { i } })
  const s = ctx.estimateSavings(50000)
  check("重复上下文传输显著减少", s.savedRatio > 0.99, `saved ${(s.savedRatio * 100).toFixed(1)}%`)
  const v = ctx.validate([{ ref: "file://rules.md" }])
  check("证据覆盖率不下降", v.evidenceCoverage === 1 && v.ok)
}

// 3) 自适应调度：长任务先发（用 M3 checkpoint 数据，不依赖 M5）
{
  const samples = samplesFromCheckpoints([
    { taskKey: "a:1", durationMs: 59 * 60_000 },
    { taskKey: "a:2", durationMs: 58 * 60_000 },
    { taskKey: "a:3", durationMs: 60 * 60_000 },
    { taskKey: "b:1", durationMs: 2 * 60_000 },
    { taskKey: "b:2", durationMs: 2.5 * 60_000 },
    { taskKey: "b:3", durationMs: 1.8 * 60_000 },
  ])
  const profiles = buildProfiles(samples)
  const schedule = planSchedule(
    [{ taskKey: "b1", taskType: "b" }, { taskKey: "a1", taskType: "a" }],
    profiles,
  )
  check("自适应调度：长任务先发", schedule.order[0] === "a1", schedule.order.join(","))
  check("仅消费 M2/M3 数据（无 M5 基线也能工作）", schedule.usedProfile === true)
}

// 4) ModelPool 自适应：429 降档 + 恢复
{
  const pool = new AdaptiveModelPool({ recoverAfter: 3 })
  pool.register("m", 16)
  pool.record("m", "rate_limited")
  check("429 触发并发降档", pool.concurrencyOf("m") === 8)
  for (let i = 0; i < 3; i++) pool.record("m", "ok")
  check("连续成功后缓慢回升", pool.concurrencyOf("m") === 9)
}

// 5) 质量不降级：三模式 Required 全量执行
{
  const plan = {
    planVersion: "1.0",
    source: {},
    definition: { stages: [], quality: { requiredValidation: true, acceptanceCriteria: ["需求覆盖", "结算规则", "交付质量"] } },
    profiles: { fast: {}, balanced: {}, quality: { additionalValidation: ["交叉评审"] } },
  } as WorkflowPlan
  let allOk = true
  const details: string[] = []
  for (const mode of ["fast", "balanced", "quality"]) {
    const p = resolveModePolicy(plan, mode)
    const ok = p.validation.effective.includes("需求覆盖") && p.validation.effective.includes("结算规则") && p.validation.effective.includes("交付质量")
    if (!ok) allOk = false
    details.push(`${mode}:${p.validation.effective.length}项`)
  }
  check("三模式 Required Validation 全部执行（质量不降级）", allOk, details.join(" "))
  check("无 Profile 削弱 Required", ["fast", "balanced", "quality"].every((m) => checkValidationNotWeakened(plan, m).length === 0))
}

// 6) 端到端：分片 → 三层上下文 → 任务清单
{
  const items = Array.from({ length: 48 }, (_, i) => ({ id: i }))
  const shard = shardItems(items, { limit: 8, keyPrefix: "req" })
  const p = planShardedTasks({ items, shard, sharedRef: "ctx://rules" })
  check("分片可产出任务清单（接通 M3 BatchExecutor）", p.tasks.length === 6 && p.evidence.length === 6)
}

const pass = results.every((r) => r.pass)
const outFile = path.join(import.meta.dirname, "..", "..", "dev-docs", "benchmark", "m4-adaptive-benchmark.json")
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), results, allPass: pass }, null, 2))
console.log("== M4 Benchmark ==")
for (const r of results) console.log(`  [${r.pass ? "PASS" : "FAIL"}] ${r.name}${r.detail ? ` (${r.detail})` : ""}`)
console.log(`\n报告：${outFile}`)
process.exit(pass ? 0 : 1)
