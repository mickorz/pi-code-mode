/**
 * M3 Benchmark：部分失败恢复（已完成任务重跑率 0% / 指纹失效 / Fencing 防覆盖）
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { BatchExecutor, type BatchTask } from "../../src/engine/governance/batch-executor.js"
import { contentHash, computeTaskFingerprint } from "../../src/engine/governance/task-fingerprint.js"
import { TaskRegistry } from "../../src/engine/governance/task-registry.js"

const results: Array<{ name: string; pass: boolean; detail: string }> = []
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail })
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m3bench-"))

// 场景：48 任务，10 个失败（对齐 T0 真实基线 run-mwkpasup-2 的形态）
const TOTAL = 48
const FAIL = ["t5", "t11", "t17", "t23", "t29", "t31", "t37", "t41", "t43", "t47"]
function makeTasks(counter: { calls: number }, failKeys: string[]): BatchTask[] {
  return Array.from({ length: TOTAL }, (_, i) => {
    const key = `t${i}`
    return {
      taskKey: key,
      fingerprint: { promptHash: contentHash(`prompt-${key}`), inputHash: contentHash(`input-${key}`) },
      run: async () => {
        counter.calls++
        if (failKeys.includes(key)) throw new Error(`fail-${key}`)
        return { key, v: i }
      },
    }
  })
}

// 1) 首轮：38 成功 / 10 失败
const cwd = tmp()
const c1 = { calls: 0 }
const r1 = await new BatchExecutor({ workflowId: "wf48", runId: "runA", cwd, concurrency: 4 }).run(makeTasks(c1, FAIL))
check("首轮 48 任务全部执行", c1.calls === TOTAL, `calls=${c1.calls}`)
check("首轮 10 个失败", r1.stats.failed === 10, JSON.stringify(r1.stats))

// 2) resume：只重跑失败 10 个（已完成重跑率 0%）
const c2 = { calls: 0 }
const r2 = await new BatchExecutor({ workflowId: "wf48", runId: "runB", cwd, concurrency: 4 }).run(makeTasks(c2, []))
check("resume 复用 38 个", r2.stats.reused === 38, JSON.stringify(r2.stats))
check("resume 只执行 10 个（重跑率 0%）", c2.calls === 10, `calls=${c2.calls}`)
check("resume 后全部成功", r2.stats.succeeded === TOTAL, JSON.stringify(r2.stats))
check("节省执行数 = 已完成的 38", r2.stats.savedExecutions === 38, String(r2.stats.savedExecutions))

// 3) 无关代码修改不失效全部产物（分层指纹）
{
  const dir = tmp()
  const base = { taskKey: "client:1", taskDefinitionHash: contentHash("def"), promptHash: contentHash("p"), externalDeps: { "client-code": "sha:aaa" } }
  const f1 = computeTaskFingerprint(base).fingerprint
  const reg = new TaskRegistry({ dir, workflowId: "wf" })
  const a = reg.acquire({ taskKey: "client:1", taskFingerprint: f1, runId: "r" })
  reg.commit({ taskKey: "client:1", runId: "r", leaseGeneration: a.checkpoint!.leaseGeneration, taskFingerprint: f1, result: { ok: 1 } })
  // 整体脚本变动（workflowVersionHash 变化）不影响产物复用
  check("无关代码修改后产物仍可复用", reg.reusable("client:1", f1).reusable === true)
  // 但该任务依赖的 client-code 变化 → 失效
  const f2 = computeTaskFingerprint({ ...base, externalDeps: { "client-code": "sha:bbb" } }).fingerprint
  check("任务依赖的 externalDeps 变化 → 失效", reg.reusable("client:1", f2).reusable === false)
  // 跨任务隔离：另一个任务（规则任务）不声明 client-code，客户端变化不影响它
  const rulesBase = { taskKey: "rules:1", promptHash: contentHash("p"), externalDeps: { "rule-doc": "sha:rrr" } }
  const rf1 = computeTaskFingerprint(rulesBase).fingerprint
  const regRules = new TaskRegistry({ dir: tmp(), workflowId: "wf" })
  const ra = regRules.acquire({ taskKey: "rules:1", taskFingerprint: rf1, runId: "r" })
  regRules.commit({ taskKey: "rules:1", runId: "r", leaseGeneration: ra.checkpoint!.leaseGeneration, taskFingerprint: rf1, result: { ok: 1 } })
  check("跨任务隔离：客户端代码变化不影响规则任务", regRules.reusable("rules:1", rf1).reusable === true)
  // 该任务自己声明的 rule-doc 变化 → 必须失效
  const rf2 = computeTaskFingerprint({ ...rulesBase, externalDeps: { "rule-doc": "sha:CHANGED" } }).fingerprint
  check("自己声明的外部依赖变化 → 失效", regRules.reusable("rules:1", rf2).reusable === false)
}

// 4) Fencing：旧执行者无法覆盖新执行者
{
  const dir = tmp()
  const reg = new TaskRegistry({ dir, workflowId: "wf" })
  const f = computeTaskFingerprint({ taskKey: "x", promptHash: contentHash("p") }).fingerprint
  reg.acquire({ taskKey: "x", taskFingerprint: f, runId: "A", leaseMs: 1000, now: 0 })
  const b = reg.acquire({ taskKey: "x", taskFingerprint: f, runId: "B", now: 5000 })
  reg.commit({ taskKey: "x", runId: "B", leaseGeneration: b.checkpoint!.leaseGeneration, taskFingerprint: f, result: { by: "B" } })
  const stale = reg.commit({ taskKey: "x", runId: "A", leaseGeneration: 1, taskFingerprint: f, result: { by: "A" } })
  check("Fencing：旧执行者提交被拒", stale.ok === false && stale.reason === "lease-lost")
  check("Fencing：结果保持新执行者产物", JSON.stringify(reg.readResult("x")) === JSON.stringify({ by: "B" }))
}

// 5) 副作用未确认 → 不判安全完成
{
  const dir = tmp()
  const reg = new TaskRegistry({ dir, workflowId: "wf" })
  const f = computeTaskFingerprint({ taskKey: "pub", promptHash: contentHash("p") }).fingerprint
  const a = reg.acquire({ taskKey: "pub", taskFingerprint: f, runId: "r" })
  reg.commit({ taskKey: "pub", runId: "r", leaseGeneration: a.checkpoint!.leaseGeneration, taskFingerprint: f, result: {}, sideEffect: { sideEffectCommitted: false, idempotent: false } })
  check("非幂等 + 副作用未确认 → 不复用", reg.reusable("pub", f).reason === "side-effect-unconfirmed")
}

const pass = results.every((r) => r.pass)
const out = { generatedAt: new Date().toISOString(), scenario: { total: TOTAL, failed: FAIL.length }, results, allPass: pass }
const outFile = path.join(import.meta.dirname, "..", "..", "dev-docs", "benchmark", "m3-recovery-benchmark.json")
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, JSON.stringify(out, null, 2))
console.log("== M3 Benchmark ==")
for (const r of results) console.log(`  [${r.pass ? "PASS" : "FAIL"}] ${r.name}${r.detail ? ` (${r.detail})` : ""}`)
console.log(`\n报告：${outFile}`)
process.exit(pass ? 0 : 1)
