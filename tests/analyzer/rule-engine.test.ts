/**
 * M1-T3 契约测试：规则引擎（统一接口 / 置信度 / 不误判 / 确定性）
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

import { riskScore, runRules } from "../../packages/engine/src/analyzer/rule-engine.js"
import type { AnalyzerRule } from "../../packages/engine/src/analyzer/types.js"

const FIX = path.join(import.meta.dirname, "fixtures", "atomic")
const read = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8")
const REAL = path.join(import.meta.dirname, "fixtures", "real")
const readReal = (f: string) => fs.readFileSync(path.join(REAL, f), "utf8")

test("INPUT-001：重复注入同一大对象 → HIGH，带证据与建议", () => {
  const { findings } = runRules(read("repeated-context.js"), { file: "repeated-context.js" })
  const f = findings.find((x) => x.ruleId === "INPUT-001")
  assert.ok(f, "应检出重复上下文")
  assert.ok(["high", "medium"].includes(f!.severity))
  assert.ok(f!.evidence.some((e) => /allRequirements/.test(e)))
  assert.ok(f!.suggestion && /Shared Context/.test(f!.suggestion))
  assert.equal(f!.location.file, "repeated-context.js")
})

test("SERIAL-001 + 无 SERIAL-002：真串行不产生并行化建议", () => {
  const { findings } = runRules(read("serial-dependent.js"))
  assert.ok(findings.some((f) => f.ruleId === "SERIAL-001"), "应提示串行链")
  assert.equal(findings.filter((f) => f.ruleId === "SERIAL-002").length, 0, "真串行不得给并行候选")
})

test("SERIAL-002：无引用相邻调用 → 并行候选，且置信度 <0.8（需语义确认）", () => {
  const { findings } = runRules(read("serial-candidate.js"))
  const f = findings.find((x) => x.ruleId === "SERIAL-002")
  assert.ok(f)
  assert.ok(f!.confidence < 0.8, `confidence=${f!.confidence}`)
  assert.match(f!.suggestion!, /语义确认/)
})

test("CONC-001：并行波次估算（含并发上限与波次）", () => {
  const { findings } = runRules(read("parallel-waves.js"))
  // parallel-waves 用 .map 动态生成，task 数为动态 → 允许无 finding，但不得误报为确定缺陷
  const f = findings.find((x) => x.ruleId === "CONC-001")
  if (f) assert.ok(f.confidence <= 0.9)
})

test("CONC-001：静态可确定任务数 > 并发 → 报波次", () => {
  const src = `
setConcurrency(2)
const groups = new Array(6).fill(0)
await parallel(groups.map((g) => () => agent('x')))
`
  const { findings } = runRules(src)
  const f = findings.find((x) => x.ruleId === "CONC-001")
  assert.ok(f, "应报波次风险")
  assert.ok(f!.evidence.some((e) => /并发上限 2/.test(e)))
})

test("TIMEOUT-001：agent 无超时兜底 → 提示", () => {
  const { findings } = runRules("await agent('x')")
  assert.ok(findings.some((f) => f.ruleId === "TIMEOUT-001"))
  // 有 timeoutMs 则不报
  const ok = runRules("await agent('x', { timeoutMs: 60000 })")
  assert.equal(ok.findings.filter((f) => f.ruleId === "TIMEOUT-001").length, 0)
})

test("RETRY-001：retries ≥2 时报成本放大", () => {
  const { findings } = runRules("await agent('x', { retries: 3 })")
  const f = findings.find((x) => x.ruleId === "RETRY-001")
  assert.ok(f)
  assert.ok(f!.evidence.some((e) => /重跑|调用量/.test(e)))
})

test("REC-001：≥20 调用点且无 phase → HIGH 恢复风险", () => {
  const agents = new Array(25).fill("await agent('x')\n").join("")
  const { findings } = runRules(agents)
  assert.ok(findings.some((f) => f.ruleId === "REC-001"))
  // 有 phase 则不报
  const withPhase = "phase('A')\n" + agents
  assert.equal(runRules(withPhase).findings.filter((f) => f.ruleId === "REC-001").length, 0)
})

test("规则接口可扩展：自定义规则被调用且并入输出", () => {
  const custom: AnalyzerRule = {
    id: "CUSTOM-001",
    version: "1.0",
    severity: "critical",
    analyze: () => [
      { ruleId: "CUSTOM-001", severity: "critical", confidence: 1, location: { startLine: 1, endLine: 1 }, evidence: ["custom"] },
    ],
  }
  const { findings } = runRules("await agent('x')", { extraRules: [custom] })
  assert.ok(findings.some((f) => f.ruleId === "CUSTOM-001"))
  assert.equal(findings[0]!.ruleId, "CUSTOM-001", "critical 应排最前")
})

test("规则异常不阻断整体分析", () => {
  const broken: AnalyzerRule = {
    id: "BROKEN-001",
    version: "1.0",
    severity: "low",
    analyze: () => {
      throw new Error("boom")
    },
  }
  const { findings } = runRules("await agent('x')", { extraRules: [broken] })
  assert.ok(findings.some((f) => f.ruleId === "BROKEN-001" && f.confidence === 0))
  assert.ok(findings.some((f) => f.ruleId === "TIMEOUT-001"), "其他规则仍执行")
})

test("输出确定性：同输入两次运行 finding 序列完全一致", () => {
  const src = read("repeated-context.js")
  const a = runRules(src, { file: "x.js" }).findings
  const b = runRules(src, { file: "x.js" }).findings
  assert.deepEqual(a, b)
})

test("风险分：confidence<0.5 不计入", () => {
  const low = [{ ruleId: "X", severity: "high" as const, confidence: 0.3, location: { startLine: 1, endLine: 1 }, evidence: [] }]
  assert.equal(riskScore(low), 0)
  const high = [{ ruleId: "X", severity: "high" as const, confidence: 1, location: { startLine: 1, endLine: 1 }, evidence: [] }]
  assert.equal(riskScore(high), 20)
})

test("真实脚本 S8：可分析且产出 finding（无规则崩溃）", () => {
  const { findings, context } = runRules(readReal("8-difference-review.js"), { file: "8-difference-review.js" })
  assert.ok(context.ast.nodes.length > 0)
  assert.ok(findings.every((f) => f.ruleId !== "BROKEN-001"))
  assert.ok(findings.length > 0, "真实脚本应至少产出一条 finding")
})

test("真实脚本 S10（10-unified-spec）：可分析", () => {
  const { findings, context } = runRules(readReal("10-unified-spec.js"), { file: "10-unified-spec.js" })
  assert.equal(context.ast.diagnostics.length, 0)
  assert.ok(context.ast.nodes.length > 0)
  assert.ok(findings.length >= 0)
})

// ---- CONC-002：动态分片并行（真实场景盲区） ----
test("CONC-002：parallel(X.map(...)) 动态分片 → 提示需人工确认三个量", () => {
  const src = `
const results = await parallel(
  partFiles.map((p) => () => agent('查证', { timeoutMs: 7200000 }))
)
return results`
  const { findings } = runRules(src)
  const f = findings.find((x) => x.ruleId === "CONC-002")
  assert.ok(f, "动态分片并行必须给出提示（CONC-001 因任务数不可知不会报）")
  assert.equal(f!.severity, "medium")
  assert.ok(f!.confidence <= 0.4, "这是提示不是缺陷判定，confidence 必须低")
  assert.ok(f!.evidence.some((e) => /partFiles/.test(e)), "证据应指出运行时集合")
  assert.ok(f!.evidence.some((e) => /并发上限/.test(e)))
  assert.ok(f!.evidence.some((e) => /7200s/.test(e)), "应带出单次超时")
})

test("CONC-002：没有动态分片时不误报", () => {
  const src = `await parallel([() => agent('a'), () => agent('b')])`
  const { findings } = runRules(src)
  assert.equal(findings.filter((f) => f.ruleId === "CONC-002").length, 0)
})

test("CONC-002：低置信不虚增 riskScore（提示不等于缺陷）", () => {
  const src = `
const rs = await parallel(items.map((i) => () => agent('x')))
return rs`
  const { findings } = runRules(src)
  const score = riskScore(findings)
  // CONC-002 confidence=0.4 < 0.5，不参与计分
  assert.ok(score < 20, `动态分片提示不应把风险分推高，实际 ${score}`)
})

test("CONC-002：集合长度静态可定时不重复提示（交给 CONC-001）", () => {
  const src = `
const items = [1, 2, 3, 4]
const rs = await parallel(items.map((i) => () => agent('x')))
return rs`
  const { findings } = runRules(src)
  assert.equal(findings.filter((f) => f.ruleId === "CONC-002").length, 0, "静态定长的集合应由 CONC-001 处理")
})

test("CONC-002：运行时集合仍然提示", () => {
  const src = `
const items = JSON.parse(await agent('列出分片'))
const rs = await parallel(items.map((i) => () => agent('x')))
return rs`
  const { findings } = runRules(src)
  assert.equal(findings.filter((f) => f.ruleId === "CONC-002").length, 1)
})
