// 内置 workflow（随包 workflows/*.js）注册契约：
//   - 无 manifest 的项目也能按名解析内置 workflow（安装即生效）
//   - 内置带 builtin 标记，项目注册条目不带
//   - 项目条目与 legacy 目录均不得使用内置 id（拒绝遮蔽，避免顶层命令错跑）
//   - 内置 id 视为保留：项目侧再注册同 id 被拒绝；内置不可注销
//   - legacy 目录扫描模式仍只扫项目目录，内置不污染排他语义
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  builtinWorkflowIds,
  builtinWorkflowsDir,
  isBuiltinWorkflow,
  loadBuiltinWorkflows,
  loadRegistry,
  registerJsonPath,
} from "../../src/engine/runtime/workflow-registry.js"
import { registerSubcommand, unregisterSubcommand } from "../../extensions/commands/workflows/register.js"

const EXPECTED_BUILTINS = ["coder", "fixer", "judge", "quality-loop", "reviewer"]

function emptyProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-builtin-reg-"))
  const file = registerJsonPath(dir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ version: 1, workflows: [] }, null, 2))
  return dir
}

function makeCtx(cwd: string) {
  const notes: Array<{ text: string; level: string }> = []
  return { ctx: { cwd, ui: { notify: (text: string, level = "info") => notes.push({ text, level }) } }, notes }
}

const deps: any = { runManager: {}, makeDeps: () => ({}), deliver: async () => {} }

test("内置目录：包根 workflows/ 且含五个内置 workflow", () => {
  assert.ok(fs.existsSync(builtinWorkflowsDir()))
  const builtins = loadBuiltinWorkflows()
  assert.deepEqual([...builtins.keys()].sort(), EXPECTED_BUILTINS)
  for (const wf of builtins.values()) {
    assert.equal(wf.builtin, true)
    assert.ok(fs.existsSync(wf.filePath))
  }
  assert.equal(isBuiltinWorkflow("coder"), true)
  assert.equal(isBuiltinWorkflow("demo_wf"), false)
  assert.deepEqual([...builtinWorkflowIds()].sort(), EXPECTED_BUILTINS)
})

test("内置按分类子目录存放（递归扫描，目录不参与 id 解析）", () => {
  const builtins = loadBuiltinWorkflows()
  for (const wf of builtins.values()) {
    const rel = path.relative(builtinWorkflowsDir(), wf.filePath).split(path.sep)
    assert.ok(rel.length >= 2, `${wf.id} 应在分类子目录内，实际 ${rel.join("/")}`)
    assert.equal(rel[rel.length - 1], `${wf.id}.js`, "文件名与 id 一致（仅组织用，解析仍按 meta.id）")
  }
  // 现有分类：单角色在 roles/，组合在 flows/
  assert.equal(path.relative(builtinWorkflowsDir(), builtins.get("coder")!.filePath).split(path.sep)[0], "roles")
  assert.equal(path.relative(builtinWorkflowsDir(), builtins.get("quality-loop")!.filePath).split(path.sep)[0], "flows")
})

test("注册表：空 manifest 的项目也能解析内置 workflow（无需注册）", () => {
  const dir = emptyProject()
  const registry = loadRegistry(dir)
  for (const id of EXPECTED_BUILTINS) {
    assert.equal(registry.get(id)?.builtin, true, `${id} 应可直接解析`)
    const filePath = registry.get(id)!.filePath
    assert.ok(filePath.startsWith(builtinWorkflowsDir() + path.sep), `${id} 应来自内置根目录之下`)
    assert.ok(fs.existsSync(filePath))
  }
})

test("注册表：legacy 目录扫描模式下内置同样可见，且项目脚本仍在", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-builtin-legacy-"))
  const legacyDir = path.join(dir, ".opencode-workflows", "workflows")
  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(path.join(legacyDir, "mine.js"), "export const meta = { name: 'mine_wf' }\nreturn await agent('x')")

  const registry = loadRegistry(dir)
  assert.equal(registry.get("mine_wf")?.builtin, undefined)
  assert.equal(registry.get("coder")?.builtin, true)
})

test("内置 id 保留：register 拒绝同名项目脚本并指明是内置", async () => {
  const dir = emptyProject()
  const script = path.join(dir, "my-coder.js")
  fs.writeFileSync(script, "export const meta = { id: 'coder', name: 'my_coder' }\nreturn await agent('x')")
  const { ctx, notes } = makeCtx(dir)

  await registerSubcommand.run([script], ctx, deps)
  assert.match(notes.at(-1)!.text, /内置 workflow 的保留 id/)
  const manifest = JSON.parse(fs.readFileSync(registerJsonPath(dir), "utf-8"))
  assert.equal(manifest.workflows.length, 0)
})

test("内置不可注销：unregister 给出明确提示且不动 manifest", async () => {
  const dir = emptyProject()
  const { ctx, notes } = makeCtx(dir)

  await unregisterSubcommand.run(["coder"], ctx, deps)
  assert.match(notes.at(-1)!.text, /内置 workflow/)
  assert.match(notes.at(-1)!.text, /不可注销/)
  assert.ok(loadRegistry(dir).has("coder"))
})

test("manifest 同 id：拒绝遮蔽内置 workflow", () => {
  const dir = emptyProject()
  fs.writeFileSync(
    registerJsonPath(dir),
    JSON.stringify(
      { version: 1, workflows: [{ id: "quality-loop", name: "my_quality_loop", file: "my-quality-loop.js", registeredAt: "T" }] },
      null,
      2,
    ),
  )
  assert.throws(() => loadRegistry(dir), /内置 workflow 的保留 id/)
})

test("legacy 同 id：拒绝遮蔽内置 workflow", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-builtin-legacy-shadow-"))
  const legacyDir = path.join(dir, ".opencode-workflows", "workflows")
  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(path.join(legacyDir, "reviewer.js"), "export const meta = { id: 'reviewer', name: 'mine_reviewer' }\nreturn await agent('x')")
  assert.throws(() => loadRegistry(dir), /内置 workflow 的保留 id.*兼容目录/)
})
