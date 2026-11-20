/** M6/M5 生产接线：runWorkflow 完成后 EvaluationReport → BaselineStore */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { runWorkflow } from "../../src/engine/runtime/workflow-runtime.js"
import { BaselineStore } from "../../src/engine/evaluator/baseline-store.js"
import { hashScript } from "../../src/engine/plan/source-fingerprint.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m6-evalwire-"))
const runner: any = { async run() { return { type: "text", value: "ok", sessionId: "s" } }, async cancel() {} }

test("runWorkflow：evaluationPlan + baselineStore → 完成后真实写基线", async () => {
  const cwd = tmp()
  const script = "export const meta = { name: 'eval_wire' }\nphase('scan')\nawait agent('a')\nreturn 'ok'"
  const scriptPath = path.join(cwd, "wf.js")
  fs.writeFileSync(scriptPath, script)
  const baseline = new BaselineStore({ cwd })
  const plan: any = {
    planVersion: "1.0",
    workflowId: "eval_wire",
    source: { scriptPath: "wf.js", scriptHash: hashScript(script) },
    definition: { stages: [{ id: "scan", type: "sequential", estimatedAgents: 1 }], quality: { requiredValidation: true } },
    profiles: { balanced: {} },
  }
  let evaluation: any
  const result = await runWorkflow(script, {
    agent: runner,
    cwd,
    runId: "eval-run-1",
    evaluationPlan: plan,
    baselineStore: baseline,
    onEvaluation: (r) => { evaluation = r },
  })
  assert.equal(result.result, "ok")
  assert.ok(evaluation, "应回调 EvaluationReport")
  const stored = baseline.get("eval_wire", plan.source.scriptHash)
  assert.ok(stored, "应写入 BaselineStore")
  assert.equal(stored!.samples[0]!.runId, "eval-run-1")
})

test("无 evaluationPlan/baselineStore：旧 workflow 不写基线", async () => {
  const cwd = tmp()
  const result = await runWorkflow("export const meta = { name: 'plain' }\nawait agent('x')\nreturn 'ok'", { agent: runner, cwd })
  assert.equal(result.result, "ok")
  assert.equal(fs.existsSync(path.join(cwd, ".pi", "workflows", "baseline")), false)
})
