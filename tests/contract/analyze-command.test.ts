/** /workflows analyze 子命令契约：会话内分析 + 报告落盘 + 摘要输出 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { analyzeSubcommand } from "../../apps/plugin/extensions/commands/workflows/analyze.js"

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
  await analyzeSubcommand.run(["wf.js", "--no-suggest", "--no-open", "--no-rule-check"], ctx, deps)
  const out = notes.at(-1)!.text
  assert.match(out, /风险分 \d+\/100/)
  assert.match(out, /调用点 2/)
})

test("analyze：完整报告落盘到 .pi/workflows/reports/", async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, "wf2.js"), "export const meta = { name: 'demo2' }\nawait agent('x')\nreturn 'ok'")
  const { notes, ctx } = ctxWith(dir)
  await analyzeSubcommand.run(["wf2.js", "--no-suggest", "--no-open", "--no-rule-check"], ctx, deps)
  assert.ok(fs.existsSync(path.join(dir, ".pi", "workflows", "reports", "wf2.analysis.md")), "md 报告应落盘")
  assert.ok(fs.existsSync(path.join(dir, ".pi", "workflows", "reports", "wf2.analysis.json")), "json 报告应落盘")
  const dashDir = path.join(dir, ".pi", "workflows", "reports", "dashboard")
  assert.ok(fs.existsSync(dashDir), "dashboard 目录应存在")
  const html = fs.readdirSync(dashDir).filter((f) => f.endsWith(".html"))
  assert.equal(html.length, 1, `应生成 1 份 dashboard，实际：${html.join(",")}`)
  assert.match(html[0]!, /^wf2分析-Dashboard-\d{8}-01\.html$/, "命名应含项目名+日期+序号")
  // --no-open 时必须把路径告诉用户（否则等于没生成）
  assert.match(notes.at(-1)!.text, /Dashboard/, "应提示 dashboard 路径")
})

test("analyze：传目录时分析目录下全部 js（不是只找入口）", async () => {
  const dir = tmp()
  const wf = path.join(dir, "demo-audit")
  fs.mkdirSync(wf, { recursive: true })
  fs.writeFileSync(path.join(wf, "a.js"), "export const meta = { name: 'a' }\nawait agent('x')\nreturn 1")
  fs.writeFileSync(path.join(wf, "b.js"), "export const meta = { name: 'b' }\nawait agent('y')\nreturn 2")

  const { notes, ctx } = ctxWith(dir)
  await analyzeSubcommand.run(["demo-audit", "--no-suggest", "--no-open", "--no-rule-check"], ctx, deps)
  const out = notes.at(-1)!.text
  assert.match(out, /风险分 \d+\/100/, `传目录应成功分析，实际：${out.slice(0, 200)}`)
  assert.doesNotMatch(out, /EISDIR/, "不得出现 EISDIR 报错")
  // 关键：目录下所有 js 都参与分析（2 个文件 / 2 个调用点）
  assert.match(out, /2 个文件/, "目录下全部 js 都要被分析")
  assert.match(out, /2 个调用点/, "两个文件的调用点都要计入")
})


test("analyze：目录内唯一 workflow 脚本时可自动解析", async () => {
  const dir = tmp()
  const wf = path.join(dir, "solo")
  fs.mkdirSync(wf, { recursive: true })
  fs.writeFileSync(path.join(wf, "entry-v2.js"), "export const meta = { name: 'solo' }\nawait agent('x')\nreturn 1")
  const { notes, ctx } = ctxWith(dir)
  await analyzeSubcommand.run(["solo", "--no-suggest", "--no-open", "--no-rule-check"], ctx, deps)
  assert.match(notes.at(-1)!.text, /风险分 \d+\/100/)
})

test("analyze：目录内多个 workflow 无同名入口 → 同样全部分析（不再要求指定入口）", async () => {
  const dir = tmp()
  const wf = path.join(dir, "multi")
  fs.mkdirSync(wf, { recursive: true })
  const BS = String.fromCharCode(92) + "n"
  for (const n of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(wf, n), `export const meta = { name: '${n}' }${BS}await agent('x')${BS}return 1`)
  }
  const { notes, ctx } = ctxWith(dir)
  await analyzeSubcommand.run(["multi", "--no-suggest", "--no-open", "--no-rule-check"], ctx, deps)
  const out = notes.at(-1)!.text
  assert.doesNotMatch(out, /EISDIR/)
  assert.doesNotMatch(out, /无法自动确定入口/, "目录模式不需要用户指定入口")
  assert.match(out, /2 个文件/, "目录下两个脚本都要分析")
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
  assert.match(analyzeSubcommand.usage, /--no-open/)
  assert.match(analyzeSubcommand.usage, /--no-rule-check/)
  assert.match(analyzeSubcommand.usage, /AI规则检查/)
  assert.match(analyzeSubcommand.usage, /Dashboard/)
})

// ---- /workflows plan validate ----
import { planSubcommand } from "../../apps/plugin/extensions/commands/workflows/analyze.js"
import { hashScript } from "../../packages/engine/src/plan/source-fingerprint.js"

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
  await analyzeSubcommand.run(["wf3.js", "--no-suggest", "--no-open", "--no-rule-check"], ctx, deps)
  const out = notes.at(-1)!.text
  assert.match(out, /风险分/)
  assert.doesNotMatch(out, /AI 优化建议/, "关闭后不应出现 AI 建议行（静态建议仍保留）")
})

// ---- 挂起保护（2026-11-19 事故回归） ----
import { createPlannerAgent } from "../../packages/tools/src/workflow-analyze-tool.js"

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
