/**
 * 跨文件聚合分析契约（2026-11-19）
 *
 * 背景：真实 workflow 是「壳 + 子流程」结构。PrdGameSkill 的 game-requirement-audit.js
 * 只有 714 行壳，真逻辑在 11 个兄弟子流程（合计 3513 行）。只分析入口会得出「风险 2/100」的假象。
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { analyzeWorkflowTree, extractScriptRefs } from "../../packages/engine/src/analyzer/tree-analyzer.js"
import { analyzeWorkflow } from "../../packages/tools/src/workflow-analyze-tool.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wf-tree-"))

function writeEntryWithChildren(dir: string, childCount: number) {
  const wfDir = path.join(dir, "audit")
  fs.mkdirSync(wfDir, { recursive: true })
  fs.writeFileSync(
    path.join(wfDir, "main.js"),
    `export const meta = { name: 'main' }
const s1 = await workflow({ scriptPath: './1-a.js' })
const s2 = await workflow({ scriptPath: './2-b.js' })
return [s1, s2]`,
  )
  for (let i = 0; i < childCount; i++) {
    // 每个子流程都放一个高风险模式：重复注入大对象（能触发 INPUT-001 high）
    fs.writeFileSync(
      path.join(wfDir, `${i + 1}-${String.fromCharCode(97 + i)}.js`),
      `export const meta = { name: 'child_${i}' }
const allRequirements = { items: new Array(50).fill('x') }
await agent('分析' + JSON.stringify(allRequirements))
await agent('复核' + JSON.stringify(allRequirements))
await agent('终审' + JSON.stringify(allRequirements))
return 'ok'`,
    )
  }
  // 非 workflow 脚本（无 meta）不应被计入
  fs.writeFileSync(path.join(wfDir, "helper.js"), "export const helper = () => 1")
  return path.join(wfDir, "main.js")
}

test("extractScriptRefs：提取 workflow 路径字面量", () => {
  const refs = extractScriptRefs(`await workflow('./1-a.js')\nawait workflow({ scriptPath: "../x/b.js" })`)
  assert.deepEqual(refs.sort(), ["../x/b.js", "./1-a.js"])
})

test("analyzeWorkflowTree：聚合同目录兄弟子流程（跳过无 meta 的文件）", () => {
  const dir = tmp()
  const entry = writeEntryWithChildren(dir, 2)
  const tree = analyzeWorkflowTree({ entryPath: entry })
  assert.equal(tree.subWorkflows.length, 2, "应聚合 2 个子 workflow，helper.js 不含 meta 不计入")
  assert.equal(tree.aggregate.files, 3)
  assert.ok(tree.aggregate.callSites > tree.entry.executionEstimate.callSites, "聚合调用点应大于入口")
  assert.ok(tree.aggregate.maxRisk >= tree.entry.summary.riskScore, "maxRisk 不应低于入口风险")
})

test("analyzeWorkflowTree：聚合口径为 max（不相加，避免虚高）", () => {
  const dir = tmp()
  const entry = writeEntryWithChildren(dir, 3)
  const tree = analyzeWorkflowTree({ entryPath: entry })
  const risks = [tree.entry.summary.riskScore, ...tree.subWorkflows.map((s) => s.riskScore)]
  assert.equal(tree.aggregate.maxRisk, Math.max(...risks))
  assert.ok(tree.aggregate.maxRisk <= 100)
})

test("analyzeWorkflowTree：子流程的问题会被聚合进来（入口干净不等于整体干净）", () => {
  const dir = tmp()
  const wfDir = path.join(dir, "audit2")
  fs.mkdirSync(wfDir, { recursive: true })
  // 入口只有普通 agent 调用（低风险）
  fs.writeFileSync(path.join(wfDir, "clean.js"), "export const meta = { name: 'clean' }\nawait agent('x', { timeoutMs: 60000 })\nreturn 'ok'")
  // 子流程有重复注入大对象（INPUT-001）
  fs.writeFileSync(
    path.join(wfDir, "dirty.js"),
    `export const meta = { name: 'dirty' }
const allRequirements = { items: new Array(50).fill('x') }
await agent('a' + JSON.stringify(allRequirements))
await agent('b' + JSON.stringify(allRequirements))
await agent('c' + JSON.stringify(allRequirements))
return 'ok'`,
  )
  const tree = analyzeWorkflowTree({ entryPath: path.join(wfDir, "clean.js") })
  assert.equal(tree.entry.summary.totalFindings, 0, "入口本身应无 finding")
  assert.ok(tree.aggregate.totalFindings > 0, "子流程的 finding 必须被聚合")
  assert.ok(tree.aggregate.maxRisk > tree.entry.summary.riskScore, "聚合风险应反映子流程")
  assert.match(String(tree.aggregate.riskiest), /dirty\.js/)
})

test("analyzeWorkflow：scriptPath 模式默认带 subtree（recursive 缺省开启）", async () => {
  const dir = tmp()
  writeEntryWithChildren(dir, 2)
  const r = await analyzeWorkflow({ scriptPath: path.join("audit", "main.js"), cwd: dir })
  assert.equal(r.ok, true)
  assert.ok(r.report?.subtree, "应带跨文件聚合")
  assert.equal(r.report!.subtree!.files, 3)
})

test("analyzeWorkflow：recursive=false 关闭聚合", async () => {
  const dir = tmp()
  writeEntryWithChildren(dir, 2)
  const r = await analyzeWorkflow({ scriptPath: path.join("audit", "main.js"), cwd: dir, recursive: false })
  assert.equal(r.report?.subtree, undefined)
})

test("analyzeWorkflow：inline source 不触发聚合（无文件系统上下文）", async () => {
  const r = await analyzeWorkflow({ source: "export const meta = { name: 'x' }\nawait agent('a')\nreturn 'ok'" })
  assert.equal(r.report?.subtree, undefined)
})
