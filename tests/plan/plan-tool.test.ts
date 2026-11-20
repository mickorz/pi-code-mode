/**
 * M2-T6 契约测试：plan_validate 工具 / CLI（与 Core 一致）
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { createPlanValidateTool, runPlanValidateCli, validatePlanFile } from "../../src/tools/plan-tool.js"
import { hashPlan, hashScript } from "../../src/engine/plan/source-fingerprint.js"

function setup(mutate?: (plan: any) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m2-plancmd-"))
  const script = "export const meta = { name: 'demo' }\nawait agent('a')"
  fs.writeFileSync(path.join(dir, "demo.js"), script)
  const plan: any = {
    planVersion: "1.0",
    workflowId: "demo",
    source: { scriptPath: "demo.js", scriptHash: hashScript(script) },
    definition: { stages: [{ id: "s", type: "sequential" }], quality: { requiredValidation: true } },
    profiles: {
      fast: { mode: "fast", concurrency: { max: 8 } },
      balanced: { mode: "balanced", concurrency: { max: 2 } },
      quality: { additionalValidation: ["交叉评审"] },
    },
  }
  mutate?.(plan)
  plan.planHash = hashPlan(plan)
  fs.writeFileSync(path.join(dir, "demo.js.plan.json"), JSON.stringify(plan, null, 2))
  return { dir, plan }
}

test("validatePlanFile：合法 Plan → PASS + 三 Profile 解析视图", () => {
  const { dir } = setup()
  const r = validatePlanFile({ planPath: "demo.js.plan.json", cwd: dir })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.defaultProfile, "balanced")
  assert.deepEqual(Object.keys(r.resolvedProfiles!).sort(), ["balanced", "fast", "quality"])
  assert.equal(r.resolvedProfiles!.fast!.concurrency, 8)
  assert.equal(r.resolvedProfiles!.fast!.requiredValidation, true)
  assert.equal(r.hashConsistent, true)
})

test("validatePlanFile：Profile 覆盖 requiredValidation → FAIL 并带路径", () => {
  const { dir } = setup((p) => {
    p.profiles.fast.requiredValidation = false
  })
  const r = validatePlanFile({ planPath: "demo.js.plan.json", cwd: dir })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /profiles\.fast\.requiredValidation/.test(e.path)))
})

test("validatePlanFile：planHash 与内容不一致 → hashConsistent=false", () => {
  const { dir, plan } = setup()
  // 写入合法 planHash 后手工篡改内容（模拟手改未重算指纹）
  const file = path.join(dir, "demo.js.plan.json")
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"))
  onDisk.profiles.fast.concurrency = { max: 99 }
  fs.writeFileSync(file, JSON.stringify(onDisk, null, 2))
  const r = validatePlanFile({ planPath: "demo.js.plan.json", cwd: dir })
  assert.equal(r.hashConsistent, false)
  assert.match(r.rendered, /Plan 被手工修改/)
})

test("validatePlanFile：脚本已改 → stale=true", () => {
  const { dir } = setup()
  fs.appendFileSync(path.join(dir, "demo.js"), "\n// edited")
  const r = validatePlanFile({ planPath: "demo.js.plan.json", cwd: dir })
  assert.equal(r.stale, true)
  assert.match(r.rendered, /需重新 analyze/)
})

test("validatePlanFile：文件不存在 → FAIL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m2-none-"))
  const r = validatePlanFile({ planPath: "nope.plan.json", cwd: dir })
  assert.equal(r.ok, false)
})

test("Pi 工具：execute 渲染校验报告", async () => {
  const { dir } = setup()
  const tool = createPlanValidateTool({ cwd: dir })
  const out: any = await tool.execute("id", { planPath: "demo.js.plan.json" })
  assert.equal(out.isError, undefined)
  assert.match(out.content[0].text, /# Plan 校验/)
  assert.match(out.content[0].text, /默认 Profile：balanced/)
})

test("CLI：无参数返回 2；合法 Plan 返回 0", () => {
  assert.equal(runPlanValidateCli([]), 2)
  const { dir } = setup()
  const prev = process.cwd()
  process.chdir(dir)
  try {
    assert.equal(runPlanValidateCli(["demo.js.plan.json"]), 0)
  } finally {
    process.chdir(prev)
  }
})
