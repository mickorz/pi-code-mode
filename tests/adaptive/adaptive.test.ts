/**
 * M4-T3/T4 契约测试：AdaptiveScheduler（消费 M2/M3 数据）+ ModelPool 自适应
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildProfiles,
  planSchedule,
  samplesFromCheckpoints,
  suggestTier,
} from "../../packages/engine/src/adaptive/adaptive-scheduler.js"
import { AdaptiveModelPool } from "../../packages/engine/src/adaptive/adaptive-model-pool.js"

test("buildProfiles：P50/P90/max 计算正确", () => {
  const p = buildProfiles([
    { taskType: "scan", durationMs: 1000 },
    { taskType: "scan", durationMs: 2000 },
    { taskType: "scan", durationMs: 3000 },
    { taskType: "scan", durationMs: 10000 },
  ])
  const scan = p.get("scan")!
  assert.equal(scan.samples, 4)
  assert.equal(scan.maxMs, 10000)
  assert.ok(scan.p50Ms >= 2000 && scan.p50Ms <= 3000)
  assert.equal(scan.confidence, 1)
})

test("buildProfiles：样本 <3 时置信度低（不做强建议）", () => {
  const p = buildProfiles([{ taskType: "x", durationMs: 500 }])
  assert.equal(p.get("x")!.confidence, 1 / 3)
})

test("samplesFromCheckpoints：从 M3 checkpoint 读取耗时（不依赖 M5 基线）", () => {
  const samples = samplesFromCheckpoints([
    { taskKey: "scan:1", durationMs: 5000 },
    { taskKey: "review:1", committedAt: 1000, updatedAt: 4000 },
    { taskKey: "broken:1" },
  ])
  assert.equal(samples.length, 2)
  assert.deepEqual(samples.map((s) => s.taskType).sort(), ["review", "scan"])
  assert.equal(samples.find((s) => s.taskType === "review")!.durationMs, 3000)
  assert.ok(samples.every((s) => s.source === "history"))
})

test("planSchedule：无画像 → 静态调度（保持声明顺序）", () => {
  const plan = planSchedule(
    [{ taskKey: "a" }, { taskKey: "b" }, { taskKey: "c" }],
    new Map(),
  )
  assert.deepEqual(plan.order, ["a", "b", "c"])
  assert.equal(plan.usedProfile, false)
  assert.ok(plan.notes.some((n) => /静态调度/.test(n)))
})

test("planSchedule：有画像 → 长任务先发（压缩尾部等待）", () => {
  const profiles = buildProfiles([
    { taskType: "short", durationMs: 1000 },
    { taskType: "short", durationMs: 1200 },
    { taskType: "short", durationMs: 900 },
    { taskType: "long", durationMs: 40000 },
    { taskType: "long", durationMs: 42000 },
    { taskType: "long", durationMs: 38000 },
    { taskType: "mid", durationMs: 8000 },
    { taskType: "mid", durationMs: 9000 },
    { taskType: "mid", durationMs: 8500 },
  ])
  const plan = planSchedule(
    [
      { taskKey: "s1", taskType: "short" },
      { taskKey: "m1", taskType: "mid" },
      { taskKey: "l1", taskType: "long" },
    ],
    profiles,
  )
  assert.equal(plan.usedProfile, true)
  assert.deepEqual(plan.order, ["l1", "m1", "s1"], "长任务必须排前")
})

test("planSchedule：同耗时保持输入顺序（稳定排序）", () => {
  const profiles = buildProfiles([
    { taskType: "t", durationMs: 1000 },
    { taskType: "t", durationMs: 1000 },
    { taskType: "t", durationMs: 1000 },
  ])
  const plan = planSchedule([{ taskKey: "a", taskType: "t" }, { taskKey: "b", taskType: "t" }], profiles)
  assert.deepEqual(plan.order, ["a", "b"])
})

test("planSchedule：样本不足的类型回落静态并记 note", () => {
  const profiles = buildProfiles([{ taskType: "rare", durationMs: 9999 }])
  const plan = planSchedule([{ taskKey: "x", taskType: "rare", estimatedMs: 100 }], profiles)
  assert.equal(plan.usedProfile, false)
  assert.ok(plan.notes.some((n) => /样本不足/.test(n)))
})

test("suggestTier：按 P90 阈值给建议（仅建议）", () => {
  const profiles = buildProfiles([
    { taskType: "fast", durationMs: 10_000 },
    { taskType: "fast", durationMs: 20_000 },
    { taskType: "fast", durationMs: 30_000 },
    { taskType: "big", durationMs: 900_000 },
    { taskType: "big", durationMs: 950_000 },
    { taskType: "big", durationMs: 1_000_000 },
  ])
  assert.equal(suggestTier("fast", profiles).tier, "fast")
  assert.equal(suggestTier("big", profiles).tier, "big")
  assert.equal(suggestTier("unknown", profiles).tier, "balanced")
})

test("AdaptiveModelPool：429 → 并发降档", () => {
  const pool = new AdaptiveModelPool()
  pool.register("m1", 16)
  const ev = pool.record("m1", "rate_limited")
  assert.equal(ev!.after, 8)
  assert.equal(pool.concurrencyOf("m1"), 8)
  assert.equal(pool.isDegraded("m1"), true)
})

test("AdaptiveModelPool：连续降档不低于最小值", () => {
  const pool = new AdaptiveModelPool({ minConcurrency: 2 })
  pool.register("m1", 16)
  for (let i = 0; i < 10; i++) pool.record("m1", "timeout")
  assert.equal(pool.concurrencyOf("m1"), 2)
})

test("AdaptiveModelPool：连续成功缓慢回升（不一次跳回）", () => {
  const pool = new AdaptiveModelPool({ recoverAfter: 3 })
  pool.register("m1", 16)
  pool.record("m1", "rate_limited") // 16 → 8
  for (let i = 0; i < 3; i++) pool.record("m1", "ok")
  assert.equal(pool.concurrencyOf("m1"), 9, "回升步长 +1")
  assert.equal(pool.isDegraded("m1"), true)
})

test("classifyError：从错误文本识别信号", () => {
  assert.equal(AdaptiveModelPool.classifyError(new Error("429 Too Many Requests")), "rate_limited")
  assert.equal(AdaptiveModelPool.classifyError(new Error("request timed out")), "timeout")
  assert.equal(AdaptiveModelPool.classifyError(new Error("bad gateway")), "error")
})

test("未知模型：record 返回 undefined 不崩溃", () => {
  const pool = new AdaptiveModelPool()
  assert.equal(pool.record("nope", "ok"), undefined)
  assert.equal(pool.concurrencyOf("nope"), undefined)
})

test("history：记录全部自适应事件（可审计）", () => {
  const pool = new AdaptiveModelPool()
  pool.register("m", 8)
  pool.record("m", "rate_limited")
  pool.record("m", "timeout")
  assert.equal(pool.history().length, 2)
  assert.match(pool.history()[0]!.reason, /限流/)
})
