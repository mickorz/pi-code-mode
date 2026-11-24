/**
 * M1-T1 契约测试：Plan Schema / Fingerprint / Validator / Loader
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { hashPlan, hashScript, canonicalJSON } from "../../packages/engine/src/plan/source-fingerprint.js"
import { validatePlan } from "../../packages/engine/src/plan/plan-validator.js"
import { loadPlan, planCandidates, resolveEffectivePolicy } from "../../packages/engine/src/plan/plan-loader.js"
import { DEFAULT_PROFILE } from "../../packages/engine/src/plan/schema.js"

function basePlan(overrides: Record<string, unknown> = {}) {
  return {
    planVersion: "1.0",
    workflowId: "demo_flow",
    source: { scriptPath: ".pi/workflows/demo.js", scriptHash: "sha256:abc", analyzedAt: "2026-11-18" },
    definition: {
      stages: [
        { id: "scan", type: "parallel", estimatedAgents: 8 },
        { id: "review", type: "parallel", dependsOn: ["scan"] },
        { id: "summary", type: "sequential", dependsOn: ["review"] },
      ],
      quality: { requiredValidation: true, acceptanceCriteria: ["全覆盖"] },
    },
    profiles: {
      fast: { mode: "fast", concurrency: { max: 8 } },
      balanced: { mode: "balanced", concurrency: { max: 4 }, budget: { maxAgents: 20 } },
      quality: { mode: "balanced", additionalValidation: ["交叉评审"] },
    },
    ...overrides,
  }
}

test("canonicalJSON：键序无关，同内容同串", () => {
  assert.equal(canonicalJSON({ b: 1, a: 2 }), canonicalJSON({ a: 2, b: 1 }))
  assert.equal(canonicalJSON({ a: undefined, b: 1 }), '{"b":1}')
})

test("hashPlan：剔除 planHash 与 analyzedAt（防自引用）", () => {
  const p1: any = basePlan()
  const h1 = hashPlan(p1)
  // 加上 planHash 自身不影响
  const p2: any = basePlan({ planHash: "sha256:whatever" })
  assert.equal(hashPlan(p2), h1)
  // analyzedAt 变化不影响
  const p3: any = basePlan()
  p3.source.analyzedAt = "2099-01-01"
  assert.equal(hashPlan(p3), h1)
  // definition 变化影响
  const p4: any = basePlan()
  p4.definition.stages[0].estimatedAgents = 99
  assert.notEqual(hashPlan(p4), h1)
})

test("hashScript：脚本内容指纹稳定", () => {
  assert.equal(hashScript("a"), hashScript("a"))
  assert.notEqual(hashScript("a"), hashScript("b"))
})

test("validatePlan：合法 Plan 通过并给出默认 Profile balanced", () => {
  const r = validatePlan(basePlan())
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.defaultProfile, DEFAULT_PROFILE)
})

test("validatePlan：Profile 声明 requiredValidation 被拒绝（Definition 强制项）", () => {
  const plan: any = basePlan()
  plan.profiles.fast.requiredValidation = false
  const r = validatePlan(plan)
  assert.equal(r.ok, false)
  assert.match(r.errors[0]!.path, /profiles\.fast\.requiredValidation/)
})

test("validatePlan：Profile 覆盖 stages 被拒绝", () => {
  const plan: any = basePlan()
  plan.profiles.fast.stages = []
  const r = validatePlan(plan)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /profiles\.fast\.stages/.test(e.path)))
})

test("validatePlan：dependsOn 指向不存在 stage 被检出", () => {
  const plan: any = basePlan()
  plan.definition.stages[1].dependsOn = ["ghost"]
  const r = validatePlan(plan)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /dependsOn/.test(e.path) && /ghost/.test(e.message)))
})

test("validatePlan：stage type 非法被检出", () => {
  const plan: any = basePlan()
  plan.definition.stages[0].type = "weird"
  const r = validatePlan(plan)
  assert.equal(r.ok, false)
})

test("validatePlan：scriptSource 变化 → Plan 过期错误", () => {
  const source = "const a = 1"
  const plan: any = basePlan()
  plan.source.scriptHash = hashScript(source)
  assert.equal(validatePlan(plan, { scriptSource: source }).ok, true)
  const r = validatePlan(plan, { scriptSource: source + " // changed" })
  assert.equal(r.ok, false)
  assert.match(r.errors[0]!.path, /source\.scriptHash/)
})

test("loadPlan：无 Plan 文件 → null + 兼容提示（旧 Workflow 正常工作）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-none-"))
  fs.writeFileSync(path.join(dir, "demo.js"), "export const meta = { name: 'demo' }")
  const r = loadPlan({ scriptPath: "demo.js", cwd: dir })
  assert.equal(r.plan, null)
  assert.equal(r.stale, false)
  assert.equal(r.defaultProfile, DEFAULT_PROFILE)
})

test("loadPlan：读取同级 <script>.plan.json 并检测过期", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-load-"))
  const script = "export const meta = { name: 'demo' }\nawait agent('x')"
  fs.writeFileSync(path.join(dir, "demo.js"), script)
  const plan: any = basePlan({ source: { scriptPath: "demo.js", scriptHash: hashScript(script) } })
  fs.writeFileSync(path.join(dir, "demo.js.plan.json"), JSON.stringify(plan))
  const ok = loadPlan({ scriptPath: "demo.js", cwd: dir })
  assert.ok(ok.plan)
  assert.equal(ok.stale, false)
  assert.equal(ok.validation?.ok, true)

  // 脚本改动 → stale
  fs.writeFileSync(path.join(dir, "demo.js"), script + "\n// edit")
  const stale = loadPlan({ scriptPath: "demo.js", cwd: dir })
  assert.equal(stale.stale, true)
})

test("planCandidates：覆盖同级与 .pi/workflows/plans 两种位置", () => {
  const c = planCandidates(".pi/workflows/demo.js", "/proj")
  assert.ok(c.some((p) => p.includes("plans") && p.endsWith("demo.plan.json")))
  assert.ok(c[0]!.endsWith("demo.js.plan.json"))
})

test("resolveEffectivePolicy：Required Validation 恒生效，Profile 只追加验证", () => {
  const plan = basePlan() as any
  const fast = resolveEffectivePolicy(plan, "fast")
  assert.equal(fast.requiredValidation, true)
  assert.deepEqual(fast.acceptanceCriteria, ["全覆盖"])
  const quality = resolveEffectivePolicy(plan, "quality")
  assert.deepEqual(quality.additionalValidation, ["交叉评审"])
  assert.equal(quality.requiredValidation, true)
})

test("resolveEffectivePolicy：未知 Profile 回落 balanced", () => {
  const plan = basePlan() as any
  const r = resolveEffectivePolicy(plan, "nonexistent")
  assert.equal(r.profile, DEFAULT_PROFILE)
})
