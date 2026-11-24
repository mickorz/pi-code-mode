/**
 * apply-e2e 链路第 ① 步（单独可跑）：
 * 等价于 /workflows optimize worker.js --rules RETRY-001 --fresh --no-open
 *
 * 与 apply-e2e-run.ts 的差别：optimize 已改为后台执行（0de7f02，晚于该驱动提交），
 * 命令立即返回、主体异步跑 —— 所以这里必须等 deliver / RunManager 终态，
 * 并在跑真实模型前先做最小预热（CLAUDE.md：验收类长任务前先预热检查模型可用）。
 */
import fs from "node:fs"
import path from "node:path"

import { optimizeSubcommand } from "../extensions/commands/workflows/optimize/index.js"
import { PiAgentAdapter } from "../src/adapter/pi-agent-adapter.js"
import { RunManager } from "../src/manager/run-manager.js"
import { readSession, sessionPaths } from "../src/engine/optimizer/session-store.js"
import { createPlannerAgent, resolveTierModel } from "../src/tools/workflow-analyze-tool.js"
import { sha256 } from "../src/engine/optimizer/target-resolver.js"
import type { WorkflowsCommandDeps } from "../extensions/commands/workflows/types.js"

const ROOT = "E:/WorkProjects/pi-code-mode/dev-examples/apply-e2e"
const TARGET = `${ROOT}/worker.js`
const WATCHDOG_MS = 15 * 60_000

// ---- ⓪ 预热：big / fast 档最小 prompt，任一失败直接中止 ----
for (const tier of ["big", "fast"] as const) {
  const model = resolveTierModel(tier, ROOT)
  const t = Date.now()
  try {
    const out = await createPlannerAgent({ cwd: ROOT, tier, timeoutMs: 120_000 })("只回复 ok")
    console.log(`[预热 ${tier}] model=${model ?? "(回退会话默认!)"} → ${out.trim().slice(0, 20)}（${((Date.now() - t) / 1000).toFixed(1)}s）✓`)
    if (!model) {
      console.error(`[预热 ${tier}] 档位未解析到模型（回退会话默认），中止——请检查 ${ROOT}/.pi/workflows/model-tiers.json`)
      process.exit(1)
    }
  } catch (e) {
    console.error(`[预热 ${tier}] model=${model} → 失败：${String((e as Error)?.message ?? e).slice(0, 300)}`)
    process.exit(1)
  }
}

// ---- ① optimize（后台模式：等 deliver / RunManager 终态） ----
const notes: Array<{ text: string; level: string }> = []
const ctx: any = {
  cwd: ROOT,
  ui: { notify: (text: string, level: string) => notes.push({ text, level }) },
  hasUI: false,
}
const runManager = new RunManager()
let settle!: () => void
const done = new Promise<void>((r) => (settle = r))
const deps: WorkflowsCommandDeps = {
  runManager,
  makeDeps: () =>
    ({
      runManager,
      adapterFactory: () => new PiAgentAdapter({ defaultCwd: ROOT }),
      cwd: ROOT,
    }) as any,
  deliver: async (text: string) => {
    notes.push({ text: `[deliver] ${text}`, level: "info" })
    settle()
  },
}

const originalHash = sha256(fs.readFileSync(TARGET, "utf8"))
console.log(`\n原文件：${TARGET}\n原 hash：${originalHash}\n含 retries: 2 → ${/retries:\s*2/.test(fs.readFileSync(TARGET, "utf8"))}`)

// 清理历史会话，保证 --fresh 语义（沙盒产物，前次验收已存档于 progress-result 报告）
const sessDir = path.join(ROOT, ".pi", "workflows", "optimizations")
fs.rmSync(sessDir, { recursive: true, force: true })

const t0 = Date.now()
const tick = setInterval(() => {
  for (const r of runManager.list()) {
    console.log(`  … ${((Date.now() - t0) / 1000).toFixed(0)}s ${r.label} status=${r.status} agents=${r.agents}`)
  }
}, 10_000)
const watchdog = setTimeout(() => {
  console.error(`\n[看门狗] ${WATCHDOG_MS / 60000} 分钟未完成，强制退出（候选目录保留可排查）`)
  process.exit(2)
}, WATCHDOG_MS)

await optimizeSubcommand.run([TARGET, "--rules", "RETRY-001", "--fresh", "--no-open"], ctx, deps)
await done
clearInterval(tick)
clearTimeout(watchdog)

console.log(`\n===== 通知 =====`)
for (const n of notes) console.log(`[${n.level}] ${n.text}`)

// ---- ② 结果落点 ----
const ids = fs.existsSync(sessDir) ? fs.readdirSync(sessDir).filter((d) => d.startsWith("opt-")) : []
if (ids.length === 0) {
  console.error("\n[失败] 没有生成会话目录")
  process.exit(1)
}
for (const id of ids) {
  const s = readSession(ROOT, id)
  const p = sessionPaths(ROOT, id)
  console.log(`\n会话 ${id}：status=${s?.status} validation=${JSON.stringify(s?.validation)}`)
  console.log(`review.md：${p.review}（存在=${fs.existsSync(p.review)}）`)
  const raw = path.join(p.dir, "patchset.raw.txt")
  if (fs.existsSync(raw)) console.log(`patchset.raw.txt 前 500 字：\n${fs.readFileSync(raw, "utf8").slice(0, 500)}`)
}
const afterHash = sha256(fs.readFileSync(TARGET, "utf8"))
console.log(`\n不变量：optimize 不修改原文件 → ${afterHash === originalHash}（期望 true）`)
console.log(`耗时：${((Date.now() - t0) / 1000).toFixed(0)}s（不含预热）`)
process.exit(0)
