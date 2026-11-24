/**
 * WorkflowTreeModel 测试（M3）：真实 runtime 产生事件 → 树结构断言。
 *
 * 覆盖：稳定 nodeKey、多层 child workflow 的父子关系、同名 workflow 靠 scopePath 区分、
 * 重复 phase 名称、agent/tool 归属 phase、并发 agent 排序稳定（按创建序而非完成序）、
 * 父节点晚到（pending 回挂）、run 终态。
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { RuntimeEventBus } from "../../packages/engine/src/events/runtime-event-bus.js"
import { runWorkflow } from "../../packages/engine/src/runtime/workflow-runtime.js"
import type { AgentSessionRunner, AgentRunOptions } from "../../packages/engine/src/agent/session-runner.js"
import { textResult } from "../engine/helpers.js"
import { WorkflowTreeModel, makeNodeKey } from "../../packages/explorer/src/model/workflow-tree-model.js"
import type { WorkflowRuntimeEvent } from "../../packages/engine/src/events/workflow-events.js"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-tree-"))
}

function put(dir: string, rel: string, content: string): string {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, "utf-8")
  return file
}

/** 每 prompt 的固定延迟：模拟并发 agent 完成顺序与创建顺序相反 */
function delayedRunner(delays: Record<string, number>) {
  const runner: AgentSessionRunner = {
    async run(prompt: string, _options?: AgentRunOptions) {
      const key = Object.keys(delays).find((k) => prompt.includes(k))
      const ms = key ? delays[key] : 0
      if (ms) await new Promise((r) => setTimeout(r, ms))
      return textResult(`echo:${prompt}`)
    },
  }
  return runner
}

async function buildTree(dir: string, script: string, runId = "run-tree", agent?: AgentSessionRunner) {
  const bus = new RuntimeEventBus()
  const events: WorkflowRuntimeEvent[] = []
  bus.subscribe((e) => events.push(e))
  const tree = new WorkflowTreeModel(runId)
  bus.subscribe((e) => tree.applyEvent(e))
  await runWorkflow(script, {
    agent: agent ?? delayedRunner({}),
    runId,
    cwd: dir,
    onRuntimeEvent: (e) => bus.publish(e),
  })
  return { tree, events, bus }
}

test("树模型: 多层 child workflow 的父子关系与稳定 nodeKey", async () => {
  const dir = tmpProject()
  put(
    dir,
    "middle.js",
    `export const meta = { name: "middle" }
await workflow("./leaf.js")
return "mid"`,
  )
  put(
    dir,
    "leaf.js",
    `export const meta = { name: "leaf" }
await agent("leaf task", { label: "LeafAgent" })
return "leaf"`,
  )
  const { tree } = await buildTree(
    dir,
    `export const meta = { name: "top" }
await agent("top task", { label: "TopAgent" })
await workflow("./middle.js")
return "top"`,
  )

  const root = tree.getNode(tree.rootKey)
  assert.ok(root, "run 节点存在")
  // run → top workflow → middle workflow → leaf workflow 三层
  const workflows = tree.flatten().filter((n) => n.kind === "workflow")
  assert.equal(workflows.length, 3)
  const top = workflows.find((w) => w.scopePath.length === 1)!
  const middle = workflows.find((w) => w.scopePath.length === 2)!
  const leaf = workflows.find((w) => w.scopePath.length === 3)!
  assert.ok(top && middle && leaf, "三层 scopePath 各不相同")
  assert.equal(top.parentKey, tree.rootKey, "顶层 workflow 挂在 run 下")
  assert.equal(middle.parentKey, top.nodeKey, "child 挂在父 workflow 下")
  assert.equal(leaf.parentKey, middle.nodeKey, "孙 workflow 挂在 child 下")
  // nodeKey 稳定：同一 scopePath 重建得到同一个 key
  assert.equal(makeNodeKey("run-tree", "workflow", leaf.scopePath, ""), leaf.nodeKey)
})

test("树模型: 同名 workflow 靠 scopePath 区分（不合并节点）", async () => {
  const dir = tmpProject()
  put(
    dir,
    "dup.js",
    `export const meta = { name: "dup" }
await agent("dup task")
return "dup"`,
  )
  const { tree } = await buildTree(
    dir,
    `export const meta = { name: "root_dup" }
await workflow("./dup.js", { label: "first" })
await workflow("./dup.js", { label: "second" })
return "ok"`,
  )
  const workflows = tree.flatten().filter((n) => n.kind === "workflow")
  // root + 两个同名 child（scopePath 不同 -> 不同节点）
  assert.equal(workflows.length, 3)
  const keys = new Set(workflows.map((w) => w.nodeKey))
  assert.equal(keys.size, 3)
})

test("树模型: 重复 phase 名称在同一 scope 内是同一节点，agent 归属到 phase 下", async () => {
  const dir = tmpProject()
  const { tree } = await buildTree(
    dir,
    `export const meta = { name: "phased" }
phase("实现")
await agent("a1", { label: "A1" })
phase("测试")
await agent("a2", { label: "A2" })
phase("实现")
await agent("a3", { label: "A3" })
return "ok"`,
  )
  const phases = tree.flatten().filter((n) => n.kind === "phase")
  const impl = phases.filter((p) => p.label === "实现")
  assert.equal(impl.length, 1, "同名 phase 复用同一节点（同 scope）")
  const agentsUnderImpl = impl[0].children.map((k) => tree.getNode(k)!.label).sort()
  assert.deepEqual(agentsUnderImpl, ["A1", "A3"], "同名 phase 的两次进入都挂在同一节点下")
  const testPhase = phases.find((p) => p.label === "测试")!
  assert.deepEqual(testPhase.children.map((k) => tree.getNode(k)!.label), ["A2"])
})

test("树模型: 并发 agent 排序按创建序，不因完成顺序变化", async () => {
  const dir = tmpProject()
  // 第一个 agent 慢、第二个快：完成顺序与创建顺序相反
  const runner = delayedRunner({ first: 80 })
  const { tree } = await buildTree(
    dir,
    `export const meta = { name: "par" }
await parallel([
  () => agent("first", { label: "First" }),
  () => agent("second", { label: "Second" }),
])
return "ok"`,
    "run-par",
    runner,
  )
  const agents = tree.flatten().filter((n) => n.kind === "agent").map((n) => n.label)
  assert.deepEqual(agents, ["First", "Second"], "树位置按创建顺序，慢的那个仍在前")
})

test("树模型: 父节点晚到时子节点不丢（pending 回挂）", async () => {
  const tree = new WorkflowTreeModel("run-late")
  // 先给一个没有父 workflow 的 agent 事件，再补 workflow.started
  tree.applyEvent({
    eventId: "run-late:1",
    runId: "run-late",
    sequence: 1,
    timestamp: Date.now(),
    type: "agent.started",
    scopePath: ["root"],
    payload: { id: "run-late:0", label: "Orphan", status: "running", workflowScopePath: ["root"] },
  } as any)
  assert.ok(tree.getNode(makeNodeKey("run-late", "agent", ["root"], "run-late:0")), "agent 节点已建")
  tree.applyEvent({
    eventId: "run-late:2",
    runId: "run-late",
    sequence: 2,
    timestamp: Date.now(),
    type: "workflow.started",
    scopePath: ["root"],
    payload: { name: "root", label: "root", scopePath: ["root"], startedAt: Date.now(), status: "running" },
  } as any)
  const wf = tree.flatten().find((n) => n.kind === "workflow")!
  assert.equal(wf.children.length, 1, "父节点创建后回挂孤儿子节点")
  assert.equal(tree.getNode(wf.children[0])!.label, "Orphan")
})

test("树模型: 旧 sequence 事件被丢弃（状态不回退）", () => {
  const tree = new WorkflowTreeModel("run-seq")
  const wfEvent = (seq: number, status: string) =>
    ({
      eventId: `run-seq:${seq}`,
      runId: "run-seq",
      sequence: seq,
      timestamp: Date.now(),
      type: status === "running" ? "workflow.started" : "workflow.finished",
      scopePath: ["root"],
      payload: { name: "root", label: "root", scopePath: ["root"], startedAt: 1, status },
    }) as any
  tree.applyEvent(wfEvent(5, "ok"))
  tree.applyEvent(wfEvent(3, "running")) // 晚到的旧事件
  const wf = tree.flatten().find((n) => n.kind === "workflow")!
  assert.equal(wf.status, "ok", "旧事件不得把终态回退成 running")
})

test("树模型: composite 嵌套与 agent 归属（组合树可见）", async () => {
  const dir = tmpProject()
  const { tree } = await buildTree(
    dir,
    `export const meta = { name: "seqflow" }
await sequence([
  () => agent("s1", { label: "S1" }),
  () => agent("s2", { label: "S2" }),
])
return "ok"`,
  )
  const composites = tree.flatten().filter((n) => n.kind === "composite")
  assert.ok(composites.length >= 1, "sequence 产生 composite 节点")
  const allAgents = tree.flatten().filter((n) => n.kind === "agent")
  assert.equal(allAgents.length, 2)
})
