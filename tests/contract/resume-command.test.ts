/** /workflows resume 子命令：任务清单渲染 + 路由装配 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { resumeSubcommand } from "../../extensions/commands/workflows/resume.js"
import { TaskRegistry } from "../../src/engine/governance/task-registry.js"
import { computeTaskFingerprint, contentHash } from "../../src/engine/governance/task-fingerprint.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m6-resume-"))

function ctxWith(dir: string) {
  const notes: string[] = []
  return { notes, ctx: { cwd: dir, ui: { notify: (t: string, _l?: string) => notes.push(t) } } }
}

test("resume --status：展示任务清单与状态统计", async () => {
  const cwd = tmp()
  fs.writeFileSync(path.join(cwd, "wf.js"), "export const meta = { name: 'resume_demo' }\nawait agent('x')\nreturn 'ok'")
  const reg = new TaskRegistry({ dir: path.join(cwd, ".pi", "workflows", "tasks"), workflowId: "resume_demo" })
  const f = computeTaskFingerprint({ taskKey: "k1", promptHash: contentHash("p") }).fingerprint
  const a = reg.acquire({ taskKey: "k1", taskFingerprint: f, runId: "r" })
  reg.commit({ taskKey: "k1", runId: "r", leaseGeneration: a.checkpoint!.leaseGeneration, taskFingerprint: f, result: { v: 1 } })

  const { notes, ctx } = ctxWith(cwd)
  await resumeSubcommand.run(["wf.js", "--status"], ctx, { runManager: {} as any, makeDeps: (() => ({})) as any, deliver: async () => {} })
  const out = notes.join("\n")
  assert.match(out, /任务清单：resume_demo/)
  assert.match(out, /done 1/)
  assert.match(out, /\[done\] k1/)
})

test("resume --status：空清单给出明确提示（不误导为失败）", async () => {
  const cwd = tmp()
  fs.writeFileSync(path.join(cwd, "wf.js"), "export const meta = { name: 'empty_demo' }\nawait agent('x')\nreturn 'ok'")
  const { notes, ctx } = ctxWith(cwd)
  await resumeSubcommand.run(["wf.js", "--status"], ctx, { runManager: {} as any, makeDeps: (() => ({})) as any, deliver: async () => {} })
  assert.match(notes.join("\n"), /任务清单为空/)
})

test("resume：无法解析 workflowId 时给出警告不崩溃", async () => {
  const cwd = tmp()
  const { notes, ctx } = ctxWith(cwd)
  await resumeSubcommand.run(["nope.js", "--tasks"], ctx, { runManager: {} as any, makeDeps: (() => ({})) as any, deliver: async () => {} })
  assert.match(notes.join("\n"), /无法解析 workflowId/)
})

test("resume：用法行包含 --tasks 与 --status", () => {
  assert.match(resumeSubcommand.usage, /--tasks/)
  assert.match(resumeSubcommand.usage, /--status/)
})
