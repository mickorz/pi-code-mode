/** M6/4：workflow_benchmark 工具契约（不伪造数据 + 真实 runOnce 路径） */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { createWorkflowBenchmarkTool } from "../../packages/tools/src/workflow-analyze-tool.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m6-bmtool-"))

test("未注入 runOnce：明确报错，不伪造 benchmark 数据", async () => {
  const tool = createWorkflowBenchmarkTool({ cwd: tmp() })
  const out: any = await tool.execute("id", { scriptPath: "wf.js" })
  assert.equal(out.isError, true)
  assert.match(out.content[0].text, /未配置 benchmark 执行器/)
})

test("注入 runOnce：真实两轮 + 改善判定", async () => {
  const cwd = tmp()
  fs.writeFileSync(path.join(cwd, "wf.js"), "await agent('x')")
  const labels: string[] = []
  const tool = createWorkflowBenchmarkTool({
    cwd,
    runOnce: async ({ label }) => {
      labels.push(label)
      return label === "before"
        ? { durationMs: 10_000, ok: true, validation: { passed: ["a"], failed: [] } }
        : { durationMs: 4_000, ok: true, validation: { passed: ["a"], failed: [] } }
    },
  })
  const out: any = await tool.execute("id", { scriptPath: "wf.js" })
  assert.deepEqual(labels, ["before", "after"])
  assert.match(out.content[0].text, /Benchmark 结果/)
  assert.match(out.content[0].text, /\| durationMs \| 10000 \| 4000 \|/)
})

test("注入 runOnce + Plan：Required Validation 未满足则不通过", async () => {
  const cwd = tmp()
  fs.writeFileSync(path.join(cwd, "wf.js"), "await agent('x')")
  const plan = {
    planVersion: "1.0",
    source: { scriptPath: "wf.js" },
    definition: { stages: [{ id: "s", type: "sequential" }], quality: { requiredValidation: true, acceptanceCriteria: ["需求覆盖"] } },
    profiles: { balanced: {} },
  }
  fs.writeFileSync(path.join(cwd, "wf.js.plan.json"), JSON.stringify(plan))
  const tool = createWorkflowBenchmarkTool({
    cwd,
    runOnce: async ({ label }) =>
      label === "before"
        ? { durationMs: 10_000, ok: true, validation: { passed: ["需求覆盖"], failed: [] } }
        : { durationMs: 3_000, ok: true, validation: { passed: [], failed: ["需求覆盖"] } },
  })
  const out: any = await tool.execute("id", { scriptPath: "wf.js", planPath: "wf.js.plan.json" })
  assert.match(out.content[0].text, /未通过/)
  assert.match(out.content[0].text, /Required Validation/)
})
