/**
 * M6-P0-2 契约测试：workflow 工具真的按 Plan 注入预算闸与并发
 * （此前审计发现：BudgetGate 存在但生产 run 从不传）
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { makeWorkflowTool } from "../../packages/tools/src/workflow-tools.js"
import { RunManager } from "../../packages/manager/src/run-manager.js"
import { hashScript } from "../../packages/engine/src/plan/source-fingerprint.js"
import type { AgentAdapter, AgentRequest } from "../../packages/adapter/src/types.js"

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m6-wire-"))
}

/** 假 adapter：立即成功，记录收到多少请求 */
function fakeAdapter(state: { calls: number }): AgentAdapter {
  return {
    async execute(_req: AgentRequest) {
      state.calls++
      return { status: "ok", output: { type: "text", value: "ok" }, sessionId: `s${state.calls}` }
    },
    async cancel() {},
  }
}

function writeProject(dir: string, opts: { maxAgents?: number } = {}) {
  const script = `export const meta = { name: 'm6_case' }
await agent('a')
await agent('b')
return 'done'
`
  fs.writeFileSync(path.join(dir, "wf.js"), script)
  const plan = {
    planVersion: "1.0",
    workflowId: "m6_case",
    source: { scriptPath: "wf.js", scriptHash: hashScript(script) },
    definition: { stages: [{ id: "s", type: "sequential" }], quality: { requiredValidation: true } },
    profiles: {
      fast: { mode: "fast", concurrency: { max: 8 } },
      balanced: {
        mode: "balanced",
        concurrency: { max: 3 },
        ...(opts.maxAgents !== undefined ? { budget: { maxAgents: opts.maxAgents } } : {}),
      },
    },
  }
  fs.writeFileSync(path.join(dir, "wf.js.plan.json"), JSON.stringify(plan, null, 2))
}

function makeTool(dir: string, state: { calls: number }) {
  return makeWorkflowTool({
    runManager: new RunManager(4),
    adapterFactory: () => fakeAdapter(state),
    cwd: dir,
  } as any)
}

test("Plan 提供时：budget.maxAgents 真的拦截真实 run（此前从不生效）", async () => {
  const dir = tmp()
  writeProject(dir, { maxAgents: 1 })
  const state = { calls: 0 }
  const tool = makeTool(dir, state)
  const out: any = await tool.execute("id", { scriptPath: "wf.js", planPath: "wf.js.plan.json" }, undefined, undefined, {})
  const text = out.content[0].text
  assert.match(text, /预算|上限|失败/, `应因预算拦截失败，实际：${text.slice(0, 200)}`)
  assert.equal(state.calls, 1, `只应执行 1 个 agent（maxAgents=1），实际 ${state.calls}`)
})

test("Plan 提供时：Profile 并发生效（balanced concurrency.max=3）", async () => {
  const dir = tmp()
  writeProject(dir)
  const state = { calls: 0 }
  const tool = makeTool(dir, state)
  const out: any = await tool.execute("id", { scriptPath: "wf.js", planPath: "wf.js.plan.json" }, undefined, undefined, {})
  assert.match(out.content[0].text, /done/, "无预算限制时应成功")
  assert.equal(state.calls, 2)
})

test("不提供 planPath：行为与旧版一致（零改动兼容）", async () => {
  const dir = tmp()
  writeProject(dir, { maxAgents: 1 })
  const state = { calls: 0 }
  const tool = makeTool(dir, state)
  const out: any = await tool.execute("id", { scriptPath: "wf.js" }, undefined, undefined, {})
  assert.match(out.content[0].text, /done/, "没有 Plan 时预算不生效")
  assert.equal(state.calls, 2)
})

test("profile 参数可选择 fast（并发 8）", async () => {
  const dir = tmp()
  writeProject(dir)
  const state = { calls: 0 }
  const tool = makeTool(dir, state)
  const out: any = await tool.execute(
    "id",
    { scriptPath: "wf.js", planPath: "wf.js.plan.json", profile: "fast" },
    undefined,
    undefined,
    {},
  )
  assert.match(out.content[0].text, /done/)
  assert.equal(state.calls, 2)
})
