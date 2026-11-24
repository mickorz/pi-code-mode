// workflow 注册表顶层命令直跑契约（无模型、无真实 workflow 执行）：
//   - 命名与冲突规则
//   - manifest 模式注册项目脚本 + 内置 workflow 无条件注册（legacy 目录扫描不注册）
//   - 注销兜底与非法参数短路（均不触达执行链）
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  directCommandConflict,
  isDirectCommandSafeName,
  registerWorkflowDirectCommands,
} from "../../apps/plugin/extensions/commands/workflows/index.js"
import { isBuiltinWorkflow, registerJsonPath } from "../../packages/engine/src/runtime/workflow-registry.js"
import { RunManager } from "../../packages/manager/src/run-manager.js"

/** fake pi：收集注册的命令；getCommands 可注入已占用名 */
function makePi(taken: string[] = []) {
  const commands = new Map<string, any>()
  const pi: any = {
    registerCommand: (name: string, opts: any) => void commands.set(name, opts),
    getCommands: () => taken.map((name) => ({ name })),
  }
  return { pi, commands }
}

/** deps：makeDeps 一旦被调用即视为误触执行链 */
function makeDepsProbe() {
  let calls = 0
  const deps = {
    runManager: new RunManager(2),
    makeDeps: () => {
      calls++
      throw new Error("contract 测试不应触达执行链")
    },
    deliver: async () => {},
  }
  return { deps, calls: () => calls }
}

function makeCtx(projectDir: string) {
  const notes: Array<{ text: string; level: string }> = []
  const ctx: any = { cwd: projectDir, ui: { notify: (text: string, level: string) => notes.push({ text, level }) } }
  return { ctx, notes }
}

const SCRIPT = `export const meta = { id: "smoke_test", name: "smoke_test", description: "demo" }\nreturn { ok: true }`

/** 建临时项目：写入脚本 + 手写 manifest 条目 */
function makeProject(entries: Array<{ id: string; file: string }>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-direct-test-"))
  const workflows: any[] = []
  for (const e of entries) {
    fs.writeFileSync(path.join(dir, e.file), SCRIPT.replace(/smoke_test/g, e.id))
    workflows.push({ id: e.id, name: e.id, description: `desc ${e.id}`, file: e.file, registeredAt: new Date(0).toISOString() })
  }
  if (entries.length) {
    fs.mkdirSync(path.dirname(registerJsonPath(dir)), { recursive: true })
    fs.writeFileSync(registerJsonPath(dir), JSON.stringify({ version: 1, workflows }, null, 2))
  }
  return dir
}

test("直跑命名: 合法与非合法名", () => {
  for (const ok of ["smoke_test", "a1-b", "A1", "x".repeat(64)]) assert.ok(isDirectCommandSafeName(ok), ok)
  for (const bad of ["", " bad", "a b", "a/b", "a\\b", ".git", "-abc", "_x", "中文", "a.b", "x".repeat(65)])
    assert.ok(!isDirectCommandSafeName(bad), JSON.stringify(bad))
})

test("直跑冲突: 宿主保留名/本扩展名/他方命令/无冲突", () => {
  const { pi } = makePi()
  assert.match(directCommandConflict(pi, "new")!, /保留/)
  assert.match(directCommandConflict(pi, "debug")!, /保留/)
  assert.match(directCommandConflict(pi, "workflows")!, /本扩展/)
  assert.match(directCommandConflict(pi, "schedule")!, /本扩展/)
  assert.match(directCommandConflict(makePi(["taken"]).pi, "taken")!, /其他扩展/)
  assert.equal(directCommandConflict(pi, "smoke_test"), undefined)
})

test("直跑冲突: getCommands 不可用时不放行（无法证实无冲突）", () => {
  const pi: any = {
    registerCommand: () => {},
    getCommands: () => {
      throw new Error("not initialized")
    },
  }
  assert.match(directCommandConflict(pi, "smoke_test")!, /无法读取/)
})

test("直跑注册: manifest 条目注册为顶层命令并标注等价 run", () => {
  const dir = makeProject([{ id: "smoke_test", file: "smoke-test.js" }])
  const { pi, commands } = makePi()
  const { deps } = makeDepsProbe()
  const r = registerWorkflowDirectCommands(pi, deps as any, dir)

  assert.deepEqual(r.registered.filter((id) => !isBuiltinWorkflow(id)), ["smoke_test"])
  assert.deepEqual(r.skipped, [])
  assert.ok(r.registered.some(isBuiltinWorkflow), "内置 workflow 无 manifest 也应注册为顶层命令")
  assert.match(commands.get("smoke_test").description, /等价 \/workflows run smoke_test/)
  assert.equal(typeof commands.get("smoke_test").handler, "function")
})

test("直跑注册: legacy 模式（无 manifest）只注册内置，不注册目录扫描脚本", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-direct-legacy-"))
  const legacyDir = path.join(dir, ".opencode-workflows", "workflows")
  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(path.join(legacyDir, "stray.js"), SCRIPT)

  const { pi, commands } = makePi()
  const r = registerWorkflowDirectCommands(pi, makeDepsProbe().deps as any, dir)
  assert.ok(r.registered.every(isBuiltinWorkflow))
  assert.ok(!r.registered.includes("stray_wf"))
  assert.equal(commands.has("stray_wf"), false)
})

test("直跑注册: 命名不安全与命令冲突的条目跳过并给出原因", () => {
  const dir = makeProject([
    { id: "smoke_test", file: "a.js" },
    { id: "new", file: "b.js" }, // 宿主保留名
  ])
  const { pi, commands } = makePi()
  const r = registerWorkflowDirectCommands(pi, makeDepsProbe().deps as any, dir)

  assert.deepEqual(r.registered.filter((id) => !isBuiltinWorkflow(id)), ["smoke_test"])
  assert.equal(r.skipped.length, 1)
  assert.match(r.skipped[0], /^\/new: .*保留/)
  assert.ok(!commands.has("new"))
})

test("直跑注册: 他方扩展占用同名命令时跳过", () => {
  const dir = makeProject([{ id: "taken_wf", file: "t.js" }])
  const { pi, commands } = makePi(["taken_wf"])
  const r = registerWorkflowDirectCommands(pi, makeDepsProbe().deps as any, dir)

  assert.ok(!r.registered.includes("taken_wf"))
  assert.match(r.skipped[0], /其他扩展/)
  assert.ok(!commands.has("taken_wf"))
})

test("直跑注册: 注册表损坏时返回原始错误且不注册", () => {
  const dir = makeProject([
    { id: "dup_wf", file: "x.js" },
    { id: "dup_wf", file: "y.js" }, // 重复 id -> loadRegistry 抛错
  ])
  const { pi, commands } = makePi()
  const r = registerWorkflowDirectCommands(pi, makeDepsProbe().deps as any, dir)

  assert.deepEqual(r.registered, [])
  assert.match(r.skipped[0], /重复/)
  assert.equal(commands.size, 0)
})

test("直跑 handler: 注销后只提示不执行", async () => {
  const dir = makeProject([{ id: "smoke_test", file: "smoke-test.js" }])
  const { pi, commands } = makePi()
  const probe = makeDepsProbe()
  registerWorkflowDirectCommands(pi, probe.deps as any, dir)
  const { ctx, notes } = makeCtx(dir)

  fs.writeFileSync(registerJsonPath(dir), JSON.stringify({ version: 1, workflows: [] }, null, 2))
  await commands.get("smoke_test").handler("", ctx)

  assert.match(notes[0].text, /已注销/)
  assert.equal(notes[0].level, "warning")
  assert.equal(probe.calls(), 0)
})

test("直跑 handler: 内置 workflow 不依赖 manifest，命令会进入执行链", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-direct-builtin-")) // 故意没有 manifest
  const { pi, commands } = makePi()
  const probe = makeDepsProbe() // makeDeps 抛错：证明通过了 registry 存在检查、进入执行链
  registerWorkflowDirectCommands(pi, probe.deps as any, dir)
  const { ctx, notes } = makeCtx(dir)

  assert.ok(commands.has("reviewer"), "内置 reviewer 应在无 manifest 时注册顶层命令")
  await commands.get("reviewer").handler("评审当前改动", ctx)
  assert.equal(probe.calls(), 1)
  assert.match(notes[0].text, /执行失败/)
  assert.ok(!notes[0].text.includes("已注销"))
})

test("直跑 handler: 参数非法时短路，不执行", async () => {
  const dir = makeProject([{ id: "smoke_test", file: "smoke-test.js" }])
  const { pi, commands } = makePi()
  const probe = makeDepsProbe()
  registerWorkflowDirectCommands(pi, probe.deps as any, dir)
  const { ctx, notes } = makeCtx(dir)

  await commands.get("smoke_test").handler("x", ctx) // 过短裸词：既非 k=v 也非指令
  assert.match(notes[0].text, /既不是 key=value 也不是指令文本/)
  assert.equal(probe.calls(), 0)
})

test("直跑 handler: 自然语言参数不被当成非法参数（放行到执行链）", async () => {
  const dir = makeProject([{ id: "smoke_test", file: "smoke-test.js" }])
  const { pi, commands } = makePi()
  const probe = makeDepsProbe() // makeDeps 故意抛错：证明解析已通过、进到执行链
  registerWorkflowDirectCommands(pi, probe.deps as any, dir)
  const { ctx, notes } = makeCtx(dir)

  await commands.get("smoke_test").handler("修复 登录 超时", ctx)
  assert.equal(notes.length, 1)
  assert.match(notes[0].text, /执行失败/)
  assert.equal(probe.calls(), 1)
})

test("直跑 handler: 注册表不可读时提示原始错误，不执行", async () => {
  const dir = makeProject([{ id: "smoke_test", file: "smoke-test.js" }])
  const { pi, commands } = makePi()
  const probe = makeDepsProbe()
  registerWorkflowDirectCommands(pi, probe.deps as any, dir)
  const { ctx, notes } = makeCtx(dir)

  fs.writeFileSync(registerJsonPath(dir), "{ broken json")
  await commands.get("smoke_test").handler("", ctx)

  assert.match(notes[0].text, /读取 workflow 注册表失败/)
  assert.equal(probe.calls(), 0)
})

// ---- 命令装配：主入口装配的闭包必须真实可执行（参考 2026-11-18 线上崩溃教训）----
test("直跑装配: /workflows 命令与直跑注册器可同时装配且互不干扰", async () => {
  const { registerWorkflowsCommand } = await import("../../apps/plugin/extensions/commands/workflows/index.js")
  const dir = makeProject([{ id: "smoke_test", file: "smoke-test.js" }])
  const { pi, commands } = makePi()
  const deps = { runManager: new RunManager(2), makeDeps: () => ({}) as any, deliver: async () => {} }

  registerWorkflowsCommand(pi, deps)
  const r = registerWorkflowDirectCommands(pi, deps as any, dir)

  assert.ok(commands.has("workflows"))
  assert.ok(commands.has("smoke_test"))
  assert.deepEqual(r.registered.filter((id) => !isBuiltinWorkflow(id)), ["smoke_test"])
  // 直跑注册器不得覆盖 /workflows 本身
  assert.equal(typeof commands.get("workflows").handler, "function")
  assert.match(commands.get("workflows").description, /workflow 命令入口/)
})
