/**
 * M6-P1-2 契约测试：降级真的生效（policy 替换 / limits 更新 / token 估算）
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import { BudgetGate } from "../../src/engine/governance/budget-gate.js"
import { estimateTokens } from "../../src/engine/governance/budget-tracker.js"
import { nextDegradeTarget } from "../../src/engine/governance/policy-state.js"

test("降级整体替换 policy：target 未声明的旧字段不残留", () => {
  const gate = new BudgetGate({
    runId: "r",
    limits: { maxInputTokens: 10 },
    activeProfile: "quality",
    initialPolicy: { concurrency: { max: 2 }, modelPolicy: { writing: "big" } },
    requiredValidation: true,
    profiles: { balanced: { concurrency: { max: 6 } }, fast: {} },
  })
  gate.beforeDispatch("a".repeat(4000)) // 触发降级 quality→balanced
  const eff = gate.policyState.policy
  assert.equal(eff.concurrency?.max, 6, "应使用 balanced 的并发")
  assert.equal(eff.modelPolicy?.writing, undefined, "quality 的 modelPolicy 必须被替换掉，不得残留")
})

test("降级收紧预算上限（只能收紧，不能放松）", () => {
  const g = new BudgetGate({
    runId: "r2",
    limits: { maxInputTokens: 10000, maxAgents: 100 },
    activeProfile: "quality",
    initialPolicy: {},
    requiredValidation: true,
    profiles: { balanced: { budget: { maxInputTokens: 500, maxAgents: 2 } }, fast: { budget: { maxAgents: 1 } } },
  })
  g.tracker.recordUsage({ input: 10001 }) // 超软限 → 触发降级
  const deg = g.maybeDegradeOnSoftLimit()
  assert.ok(deg, "应触发降级")
  assert.equal(g.tracker.limits.maxInputTokens, 500, "降级后 input 上限收紧到目标值")
  assert.equal(g.tracker.limits.maxAgents, 2, "降级后 agent 上限收紧")

  // 目标未声明的上限保持不变（不清空 → 不会因降级变成无限额）
  const g2 = new BudgetGate({
    runId: "r3",
    limits: { maxInputTokens: 100, maxOutputTokens: 50 },
    activeProfile: "quality",
    initialPolicy: {},
    requiredValidation: true,
    profiles: { balanced: { budget: { maxInputTokens: 10 } }, fast: {} },
  })
  g2.tracker.recordUsage({ input: 200 })
  g2.maybeDegradeOnSoftLimit()
  assert.equal(g2.tracker.limits.maxInputTokens, 10)
  assert.equal(g2.tracker.limits.maxOutputTokens, 50, "目标未声明的上限必须保持，不得清空")
})

test("未知 Profile 降级目标为 balanced（不再一步跳 fast）", () => {
  assert.equal(nextDegradeTarget("custom-tier"), "balanced")
  assert.equal(nextDegradeTarget("quality"), "balanced")
  assert.equal(nextDegradeTarget("balanced"), "fast")
})

test("中文 token 估算不再低估 2-3 倍", () => {
  const zh = "这是一段中文文本用于测试令牌估算的准确性"
  const en = "this is an english sentence for token estimation test"
  const zhEst = estimateTokens(zh)
  const enEst = estimateTokens(en)
  // 中文 20 字 ≈ 13 token（1.5 字符/token），旧实现会给 5
  assert.ok(zhEst >= 12, `中文估算 ${zhEst} 应 ≥12（旧实现约 5）`)
  assert.ok(zhEst / zh.length > 0.5, "中文每字符 token 比应 >0.5")
  // 英文仍约 4 字符/token
  assert.ok(Math.abs(enEst - Math.ceil(en.length / 4)) <= 1)
})

test("空字符串估算为 1（不返回 0 导致除零）", () => {
  assert.equal(estimateTokens(""), 1)
})
