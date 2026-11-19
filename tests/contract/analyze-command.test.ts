/** /workflows analyze 子命令契约：会话内分析 + 报告落盘 + 摘要输出 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { analyzeSubcommand } from "../../extensions/commands/workflows/analyze.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wf-analyze-"))

function ctxWith(dir: string) {
  const notes: Array<{ text: string; level?: string }> = []
  return {
    notes,
    ctx: { cwd: dir, ui: { notify: (text: string, level?: string) => notes.push({ text, level }) } },
  }
}

const deps = { runManager: {} as any, makeDeps: (() => ({})) as any, deliver: async () => {} }

test("analyze：分析脚本并输出风险分摘要", async () => {
  const dir = tmp()
  fs.writeFileSync(
    path.join(dir, "wf.js"),
    `export const meta = { name: 'demo' }
const all = { a: 1 }
await agent('分析' + JSON.stringify(all))
await agent('复核' + JSON.stringify(all))
return 'ok'`,
  )
  const { notes, ctx } = ctxWith(dir)
  await analyzeSubcommand.run(["wf.js", "--no-suggest"], ctx, deps)
  const out = notes.at(-1)!.text
  assert.match(out, /风险分 \d+\/100/)
  assert.match(out, /调用点 2/)
})

test("analyze：完整报告落盘到 .pi/workflows/reports/", async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, "wf2.js"), "export const meta = { name: 'demo2' }\nawait agent('x')\nreturn 'ok'")
  const { notes, ctx } = ctxWith(dir)
  await analyzeSubcommand.run(["wf2.js", "--no-suggest"], ctx, deps)
  assert.ok(fs.existsSync(path.join(dir, ".pi", "workflows", "reports", "wf2.analysis.md")), "md 报告应落盘")
  assert.ok(fs.existsSync(path.join(dir, ".pi", "workflows", "reports", "wf2.analysis.json")), "json 报告应落盘")
  assert.match(notes.at(-1)!.text, /完整报告/)
})

test("analyze：缺参数提示用法", async () => {
  const { notes, ctx } = ctxWith(tmp())
  await analyzeSubcommand.run([], ctx, deps)
  assert.match(notes.at(-1)!.text, /用法: \/workflows analyze/)
})

test("analyze：脚本不存在给出路径提示", async () => {
  const { notes, ctx } = ctxWith(tmp())
  await analyzeSubcommand.run(["nope.js"], ctx, deps)
  assert.match(notes.at(-1)!.text, /找不到脚本/)
  assert.equal(notes.at(-1)!.level, "warning")
})

test("analyze：usage 声明别名与关键开关", () => {
  assert.match(analyzeSubcommand.usage, /别名 anal/)
  assert.match(analyzeSubcommand.usage, /--no-suggest/)
})

// ---- /workflows plan validate ----
import { planSubcommand } from "../../extensions/commands/workflows/analyze.js"
import { hashScript } from "../../src/engine/plan/source-fingerprint.js"

test("plan validate：合法 Plan 输出 PASS", async () => {
  const dir = tmp()
  const script = "export const meta = { name: 'demo' }\nawait agent('x')"
  fs.writeFileSync(path.join(dir, "wf.js"), script)
  const plan = {
    planVersion: "1.0",
    source: { scriptPath: "wf.js", scriptHash: hashScript(script) },
    definition: { stages: [{ id: "s", type: "sequential" }], quality: { requiredValidation: true } },
    profiles: { balanced: {}, quality: { additionalValidation: ["交叉评审"] } },
  }
  fs.writeFileSync(path.join(dir, "wf.js.plan.json"), JSON.stringify(plan))
  const { notes, ctx } = ctxWith(dir)
  await planSubcommand.run(["validate", "wf.js.plan.json"], ctx, deps)
  const out = notes.at(-1)!.text
  assert.match(out, /结果：PASS/)
  assert.match(out, /默认 Profile：balanced/)
})

test("plan validate：Profile 削弱强制验证 → FAIL", async () => {
  const dir = tmp()
  const script = "export const meta = { name: 'demo' }\nawait agent('x')"
  fs.writeFileSync(path.join(dir, "wf.js"), script)
  const plan: any = {
    planVersion: "1.0",
    source: { scriptPath: "wf.js", scriptHash: hashScript(script) },
    definition: { stages: [{ id: "s", type: "sequential" }], quality: { requiredValidation: true } },
    profiles: { balanced: {}, fast: { requiredValidation: false } },
  }
  fs.writeFileSync(path.join(dir, "wf.js.plan.json"), JSON.stringify(plan))
  const { notes, ctx } = ctxWith(dir)
  await planSubcommand.run(["validate", "wf.js.plan.json"], ctx, deps)
  assert.match(notes.at(-1)!.text, /FAIL|requiredValidation/)
})

test("plan：缺参数提示用法", async () => {
  const { notes, ctx } = ctxWith(tmp())
  await planSubcommand.run([], ctx, deps)
  assert.match(notes.at(-1)!.text, /用法: \/workflows plan validate/)
})

test("analyze：--no-suggest 关闭 AI 建议（默认开启）", async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, "wf3.js"), "export const meta = { name: 'demo3' }\nawait agent('x')\nreturn 'ok'")
  const { notes, ctx } = ctxWith(dir)
  await analyzeSubcommand.run(["wf3.js", "--no-suggest"], ctx, deps)
  const out = notes.at(-1)!.text
  assert.match(out, /风险分/)
  assert.doesNotMatch(out, /AI 优化建议/, "关闭后不应出现 AI 建议行（静态建议仍保留）")
})

// ---- 挂起保护（2026-11-19 事故回归） ----
import { createPlannerAgent } from "../../src/tools/workflow-analyze-tool.js"

test("createPlannerAgent：1ms 超时必然抛错（证明超时通道生效，不依赖模型速度）", async () => {
  const agent = createPlannerAgent({ cwd: tmp(), timeoutMs: 1 })
  const started = Date.now()
  // 1ms 内不可能完成一次模型往返 → 必走超时/失败分支；关键是「必须抛错而不是无限挂起」
  await assert.rejects(async () => await agent("只回复 ok"))
  assert.ok(Date.now() - started < 20_000, "必须在超时窗口内返回，不能长时间挂起")
})

test("analyze：内部异常必须 notify 出来（禁止静默无反应）", async () => {
  const dir = tmp()
  // 造一个会抛错的场景：cwd 不存在时 resolveScript/analyze 内部抛 ENOENT
  const { notes, ctx } = ctxWith(path.join(dir, "missing-dir"))
  await analyzeSubcommand.run(["wf.js", "--no-suggest"], ctx, deps)
  assert.ok(notes.length > 0, "必须至少有一条 notify，不能完全静默")
  const joined = notes.map((n) => n.text).join("\n")
  assert.match(joined, /找不到脚本|分析失败/)
})
