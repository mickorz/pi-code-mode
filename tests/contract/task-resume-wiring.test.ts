/** M6/M3 生产接线：workflow taskResume → TaskRegistry → agent 复用 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { makeWorkflowTool } from "../../packages/tools/src/workflow-tools.js"
import { RunManager } from "../../packages/manager/src/run-manager.js"
import type { AgentAdapter, AgentRequest } from "../../packages/adapter/src/types.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m6-taskwire-"))
function adapter(state: { calls: number }): AgentAdapter {
  return { async execute(_r: AgentRequest) { state.calls++; return { status: "ok", output: { type: "text", value: "ok" }, sessionId: `s${state.calls}` } }, async cancel() {} }
}

test("workflow taskResume=true：第一次执行落 checkpoint，第二次复用不调用 agent", async () => {
  const cwd = tmp()
  const script = `export const meta = { name: 'task_wire' }\nawait agent('same', { replayable: true })\nreturn 'done'`
  const state = { calls: 0 }
  const tool = makeWorkflowTool({ runManager: new RunManager(4), adapterFactory: () => adapter(state), cwd } as any)
  const a: any = await tool.execute("id", { script: script, taskResume: true }, undefined, undefined, {})
  assert.match(a.content[0].text, /done/)
  assert.equal(state.calls, 1)
  const b: any = await tool.execute("id", { script: script, taskResume: true }, undefined, undefined, {})
  assert.match(b.content[0].text, /done/)
  assert.equal(state.calls, 1, "第二次应从 TaskCheckpoint 复用")
  const taskDir = path.join(cwd, ".pi", "workflows", "tasks")
  assert.ok(fs.existsSync(taskDir))
})

test("taskResume=false：旧路径正常执行（不启用 TaskRegistry）", async () => {
  const cwd = tmp()
  const script = `export const meta = { name: 'plain_wire' }\nawait agent('same', { replayable: true })\nreturn 'done'`
  const state = { calls: 0 }
  const tool = makeWorkflowTool({ runManager: new RunManager(4), adapterFactory: () => adapter(state), cwd } as any)
  await tool.execute("id", { script }, undefined, undefined, {})
  await tool.execute("id", { script }, undefined, undefined, {})
  assert.equal(state.calls, 2)
})
