/**
 * M4-T5/T6 契约测试：Effective Validation 策略 + M4 Benchmark
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { checkValidationNotWeakened, resolveModePolicy } from "../../src/engine/adaptive/mode-policy.js"
import { planShardedTasks, shardItems, verifyShards } from "../../src/engine/adaptive/sharder.js"
import { LayeredContext } from "../../src/engine/adaptive/context-layers.js"
import { buildProfiles, planSchedule, samplesFromCheckpoints } from "../../src/engine/adaptive/adaptive-scheduler.js"
import { BatchExecutor, type BatchTask } from "../../src/engine/governance/batch-executor.js"
import { contentHash } from "../../src/engine/governance/task-fingerprint.js"
import type { WorkflowPlan } from "../../src/engine/plan/schema.js"

function plan(over: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    planVersion: "1.0",
    source: {},
    definition: {
      stages: [],
      quality: { requiredValidation: true, acceptanceCriteria: ["需求覆盖检查", "关键结算规则验证", "最终交付质量检查"] },
    },
    profiles: {
      fast: { mode: "fast", concurrency: { max: 8 } },
      balanced: { mode: "balanced", concurrency: { max: 4 } },
      quality: { mode: "balanced", additionalValidation: ["交叉评审"] },
    },
    ...over,
  } as WorkflowPlan
}

test("Effective Validation = Required ∪ Profile（fast 不可关闭强制项）", () => {
  const p = resolveModePolicy(plan(), "fast")
  assert.equal(p.validation.requiredEnabled, true)
  assert.deepEqual(p.validation.required, ["需求覆盖检查", "关键结算规则验证", "最终交付质量检查"])
  assert.equal(p.validation.effective.length, 3, "fast 也必须全量执行 Required")
})

test("quality 模式：追加验证但 Required 仍全量", () => {
  const p = resolveModePolicy(plan(), "quality")
  assert.equal(p.validation.effective.length, 4)
  assert.ok(p.validation.effective.includes("交叉评审"))
  assert.equal(p.crossValidation, true)
  assert.ok(p.reviewRounds >= 2)
})

test("checkValidationNotWeakened：合规 Profile 无违规项", () => {
  for (const mode of ["fast", "balanced", "quality"]) {
    assert.deepEqual(checkValidationNotWeakened(plan(), mode), [], `${mode} 不应削弱 Required`)
  }
})

test("去重：Profile 追加与 Required 重叠时只保留一份", () => {
  const p = plan({ profiles: { fast: { additionalValidation: ["需求覆盖检查"] } } })
  const r = resolveModePolicy(p, "fast")
  assert.equal(r.validation.effective.filter((x) => x === "需求覆盖检查").length, 1)
})

test("分片 → 任务 → 三层上下文 → BatchExecutor 端到端（48 项，确定性）", async () => {
  const items = Array.from({ length: 48 }, (_, i) => ({ id: i, text: `需求条目 ${i}` }))
  const shard = shardItems(items, { strategy: "count", limit: 8, keyPrefix: "req" })
  assert.equal(shard.shards.length, 6)
  assert.equal(verifyShards(items, shard).ok, true)

  const ctx = new LayeredContext()
  ctx.registerShared({ ref: "ctx://rules", summary: "规则导航", sourceBytes: 50_000, evidence: [{ ref: "file://rules.md" }] })
  const planTasks = planShardedTasks({ items, shard, sharedRef: "ctx://rules" })
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "m4-e2e-"))
  const calls = { n: 0 }
  const tasks: BatchTask[] = planTasks.tasks.map((t) => ({
    taskKey: t.taskKey,
    fingerprint: { promptHash: contentHash(String(ctx.fingerprint("ctx://rules")) + t.taskKey) },
    run: async () => {
      calls.n++
      return { taskKey: t.taskKey, count: t.items.length }
    },
  }))
  const r = await new BatchExecutor({ workflowId: "m4e2e", runId: "run1", cwd, concurrency: 4 }).run(tasks)
  assert.equal(r.stats.total, 6)
  assert.equal(calls.n, 6)

  // resume：全部复用
  const r2 = await new BatchExecutor({ workflowId: "m4e2e", runId: "run2", cwd, concurrency: 4 }).run(tasks)
  assert.equal(r2.stats.reused, 6)
  assert.equal(calls.n, 6, "resume 不应再执行")
})

test("自适应调度端到端：用 checkpoint 耗时画像重排", () => {
  const samples = samplesFromCheckpoints([
    { taskKey: "slow:1", durationMs: 40_000 },
    { taskKey: "slow:2", durationMs: 42_000 },
    { taskKey: "slow:3", durationMs: 39_000 },
    { taskKey: "fast:1", durationMs: 1_000 },
    { taskKey: "fast:2", durationMs: 1_100 },
    { taskKey: "fast:3", durationMs: 900 },
  ])
  const profiles = buildProfiles(samples)
  const schedule = planSchedule(
    [{ taskKey: "f1", taskType: "fast" }, { taskKey: "s1", taskType: "slow" }],
    profiles,
  )
  assert.equal(schedule.usedProfile, true)
  assert.deepEqual(schedule.order, ["s1", "f1"])
})

test("证据覆盖率不下降：三层上下文校验", () => {
  const ctx = new LayeredContext()
  const expected = [{ ref: "file://rules.md" }, { ref: "file://cases.json" }]
  ctx.registerShared({ ref: "ctx://rules", evidence: expected })
  const v = ctx.validate(expected)
  assert.equal(v.evidenceCoverage, 1)
  assert.equal(v.ok, true)
})
