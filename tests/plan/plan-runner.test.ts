/**
 * M2-T4 契约测试：Plan Runner（Plan → RunConfig + 预算闸注入）
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { parsePlanArgs, resolvePlanContext, scriptFromPlanPath, toRunConfig } from "../../packages/engine/src/plan/plan-runner.js"
import { hashScript } from "../../packages/engine/src/plan/source-fingerprint.js"
import { runWorkflow } from "../../packages/engine/src/runtime/workflow-runtime.js"

function setup(planOver: Record<string, unknown> = {}, scriptBody = "await agent('a')\nawait agent('b')\nreturn 'done'") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m2-plan-"))
  const script = `export const meta = { name: 'm2_plan' }\n${scriptBody}`
  fs.writeFileSync(path.join(dir, "demo.js"), script)
  const plan = {
    planVersion: "1.0",
    workflowId: "demo_flow",
    source: { scriptPath: "demo.js", scriptHash: hashScript(script) },
    definition: { stages: [{ id: "s1", type: "sequential" }], quality: { requiredValidation: true } },
    profiles: {
      fast: { mode: "fast", concurrency: { max: 8 }, budget: { maxAgents: 50 } },
      balanced: { mode: "balanced", concurrency: { max: 2 }, budget: { maxAgents: 1 } },
      quality: { mode: "balanced", additionalValidation: ["交叉评审"] },
    },
    ...planOver,
  }
  fs.writeFileSync(path.join(dir, "demo.js.plan.json"), JSON.stringify(plan))
  return { dir, plan }
}

test("resolvePlanContext：无 Plan → null（旧 Workflow 兼容）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m2-noplan-"))
  fs.writeFileSync(path.join(dir, "x.js"), "await agent('a')")
  assert.equal(resolvePlanContext({ scriptPath: "x.js", cwd: dir, runId: "r" }), null)
})

test("resolvePlanContext：读取 Plan，默认 Profile balanced，注入 budget/concurrency", () => {
  const { dir } = setup()
  const ctx = resolvePlanContext({ scriptPath: "demo.js", cwd: dir, runId: "r1" })!
  assert.ok(ctx)
  assert.equal(ctx.activeProfile, "balanced")
  assert.equal(ctx.concurrency, 2)
  assert.equal(ctx.requiredValidation, true)
  assert.match(ctx.planHash, /^sha256:/)
  assert.match(ctx.profileHash, /^sha256:/)
})

test("resolvePlanContext：--profile 指定 fast", () => {
  const { dir } = setup()
  const ctx = resolvePlanContext({ scriptPath: "demo.js", cwd: dir, runId: "r1", profile: "fast" })!
  assert.equal(ctx.activeProfile, "fast")
  assert.equal(ctx.concurrency, 8)
})

test("resolvePlanContext：未知 Profile 回落默认并记 note", () => {
  const { dir } = setup()
  const ctx = resolvePlanContext({ scriptPath: "demo.js", cwd: dir, runId: "r1", profile: "ghost" })!
  assert.equal(ctx.activeProfile, "balanced")
  assert.ok(ctx.notes.some((n) => /ghost/.test(n)))
})

test("resolvePlanContext：Plan 过期 → note 提示", () => {
  const { dir } = setup()
  fs.writeFileSync(path.join(dir, "demo.js"), "export const meta = { name: 'm2_plan' }\n// edited\nawait agent('a')\nreturn 'done'")
  const ctx = resolvePlanContext({ scriptPath: "demo.js", cwd: dir, runId: "r1" })!
  assert.ok(ctx.notes.some((n) => /过期/.test(n)))
})

test("toRunConfig：activeProfile/planHash/profileHash 齐全", () => {
  const { dir } = setup()
  const ctx = resolvePlanContext({ scriptPath: "demo.js", cwd: dir, runId: "r9" })!
  const cfg = toRunConfig(ctx)
  assert.equal(cfg.runId, "r9")
  assert.equal(cfg.activeProfile, "balanced")
  assert.equal(cfg.workflowId, "demo_flow")
  assert.ok(cfg.planHash)
  assert.ok(cfg.profileHash)
})

test("端到端：Plan budget 真被执行（maxAgents=1 拦截第二个 agent）", async () => {
  const { dir } = setup()
  const ctx = resolvePlanContext({ scriptPath: "demo.js", cwd: dir, runId: "r-e2e" })!
  const script = fs.readFileSync(path.join(dir, "demo.js"), "utf8")
  const runner: any = {
    async run(p: string) {
      return { type: "text", value: "ok", sessionId: "s" }
    },
    async cancel() {},
  }
  await assert.rejects(
    runWorkflow(script, { agent: runner, cwd: dir, budgetGate: ctx.budgetGate, agentRetries: 0 }),
    /预算拦截|agent 数已达上限/,
  )
})

test("端到端：无 Plan 时 workflow 正常执行", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m2-plain-"))
  const runner: any = { async run() { return { type: "text", value: "ok", sessionId: "s" } }, async cancel() {} }
  const r = await runWorkflow("export const meta = { name: 'plain' }\nawait agent('a')\nreturn 'ok'", { agent: runner, cwd: dir })
  assert.equal(r.result, "ok")
})

test("parsePlanArgs / scriptFromPlanPath：CLI 参数解析", () => {
  assert.deepEqual(parsePlanArgs(["demo.js", "--plan", "x.plan.json", "--profile", "fast"]), {
    scriptPath: "demo.js",
    planPath: "x.plan.json",
    profile: "fast",
  })
  const { dir } = setup()
  assert.ok(scriptFromPlanPath(path.join(dir, "demo.js.plan.json"), dir)?.endsWith("demo.js"))
})
