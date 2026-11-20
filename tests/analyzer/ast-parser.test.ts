/**
 * M1-T2 契约测试：AST Analyzer（调用识别 / 依赖置信度 / 动态边界）
 * 用 7 个原子 fixtures 逐项验收（文档：执行计划 M1-T2）
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

import { analyzeAst } from "../../src/engine/analyzer/ast-parser.js"
import { analyzeDependencies, buildCallGraph } from "../../src/engine/analyzer/call-graph.js"

const FIX = path.join(import.meta.dirname, "fixtures", "atomic")
const read = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8")

test("serial-dependent：Explicit 串行链，不建议并行", () => {
  const ast = analyzeAst(read("serial-dependent.js"))
  const g = buildCallGraph(ast)
  const d = analyzeDependencies(ast, g)
  assert.equal(g.counts.agent, 3)
  assert.equal(d.byConfidence.Explicit, 2)
  assert.deepEqual(d.serialChains, [["call-1", "call-2", "call-3"]])
  assert.equal(d.candidates.length, 0, "真串行不得产生并行候选")
})

test("serial-candidate：无引用 → Candidate（不自动采纳）", () => {
  const ast = analyzeAst(read("serial-candidate.js"))
  const d = analyzeDependencies(ast, buildCallGraph(ast))
  assert.equal(d.byConfidence.Explicit, 0)
  assert.equal(d.byConfidence.Candidate, 2)
  assert.equal(d.candidates.length, 1)
  assert.equal(d.candidates[0]!.ids.length, 3)
})

test("dynamic-loop：动态节点 + Unknown，不估算具体次数", () => {
  const ast = analyzeAst(read("dynamic-loop.js"))
  const d = analyzeDependencies(ast, buildCallGraph(ast))
  assert.equal(ast.nodes.length, 1)
  assert.equal(ast.nodes[0]!.dynamic, true)
  assert.ok(d.unknowns.length >= 1)
  // 不得伪造精确调用数
  assert.equal(ast.nodes[0]!.loopBounds?.max, undefined)
})

test("dynamic-dispatch：动态分发 → Unknown（无调用节点也不误判）", () => {
  const ast = analyzeAst(read("dynamic-dispatch.js"))
  assert.equal(ast.nodes.length, 0)
  assert.ok(ast.unknowns.some((u) => /动态分发/.test(u.reason)))
})

test("parallel-waves：parallel 容器 + 容器内 agent 归属", () => {
  const ast = analyzeAst(read("parallel-waves.js"))
  const g = buildCallGraph(ast)
  assert.equal(g.counts.parallel, 1)
  assert.equal(g.counts.agent, 1)
  const agent = ast.nodes.find((n) => n.kind === "agent")!
  assert.ok(agent.containerId, "agent 应归属到 parallel 容器")
  assert.ok(ast.edges.some((e) => e.confidence === "Structural"))
})

test("sub-workflow：workflow 子流程调用 + 路径提取 + Explicit 依赖", () => {
  const ast = analyzeAst(read("sub-workflow.js"))
  const g = buildCallGraph(ast)
  assert.equal(g.counts.workflow, 2)
  const paths = ast.nodes.filter((n) => n.kind === "workflow").map((n) => n.scriptPath)
  assert.deepEqual(paths, ["./1-spec.js", "./2-design.js"])
  assert.ok(ast.edges.some((e) => e.confidence === "Explicit"))
})

test("repeated-context：三次 agent 调用均被识别（重复注入交由规则引擎判定）", () => {
  const ast = analyzeAst(read("repeated-context.js"))
  assert.equal(ast.nodes.filter((n) => n.kind === "agent").length, 3)
})

test("语法错误：记 diagnostics 不抛错", () => {
  const ast = analyzeAst("const x = (")
  assert.ok(ast.diagnostics.length > 0)
  assert.equal(ast.nodes.length, 0)
})

test("真实脚本：8-difference-review 可解析且识别出调用结构", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "real", "8-difference-review.js"), "utf8")
  const ast = analyzeAst(src)
  assert.equal(ast.diagnostics.length, 0, JSON.stringify(ast.diagnostics))
  const g = buildCallGraph(ast)
  assert.ok((g.counts.agent ?? 0) >= 1, `agent 调用数=${g.counts.agent}`)
  assert.ok(ast.nodes.length > 0)
})

test("真实脚本：game-prd-check（1212 行）可解析", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "real", "game-prd-check.js"), "utf8")
  const ast = analyzeAst(src)
  assert.equal(ast.diagnostics.length, 0, JSON.stringify(ast.diagnostics))
  assert.ok(ast.nodes.length > 5, `节点数=${ast.nodes.length}`)
})
