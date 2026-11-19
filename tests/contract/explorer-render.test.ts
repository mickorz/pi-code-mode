/**
 * Explorer TUI 渲染契约测试（M6）：不启动真实 TUI，只断言渲染输出可安全生成。
 *
 * 重点：空态不崩、四 Tab 都有输出、宽/窄终端两种布局、行宽不超宽（终端列宽约束）、
 * 渲染异常不外抛（自防御：异常会击穿宿主进程）。
 */

import test from "node:test"
import assert from "node:assert/strict"
import { visibleWidth } from "@earendil-works/pi-tui"
import { renderExplorerBox, renderExplorerFrame, wrapByWidth } from "../../extensions/explorer/render.js"
import type { ExplorerViewState } from "../../src/explorer/controller/explorer-controller.js"
import type { WorkflowTreeNode } from "../../src/explorer/model/workflow-tree-model.js"

const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s }

function node(partial: Partial<WorkflowTreeNode> & { nodeKey: string }): WorkflowTreeNode {
  return {
    runId: "r1",
    kind: "workflow",
    label: "wf",
    status: "running",
    scopePath: ["root"],
    children: [],
    createdSequence: 0,
    updatedSequence: 0,
    ...partial,
  }
}

function state(over: Partial<ExplorerViewState> = {}): ExplorerViewState {
  const root = node({ nodeKey: "run", kind: "run", label: "r1", scopePath: [] })
  const wf = node({ nodeKey: "wf", parentKey: "run", label: "需求分析", scopePath: ["root"] })
  const phase = node({ nodeKey: "phase", parentKey: "wf", kind: "phase", label: "实现", scopePath: ["root"] })
  const agent = node({
    nodeKey: "agent|run|agent|root|r1:0",
    parentKey: "phase",
    kind: "agent",
    label: "AgentA",
    status: "ok",
    durationMs: 1500,
    metadata: { model: "p/m", tokens: 120, attempt: 1 },
  })
  root.children = ["wf"]
  wf.children = ["phase"]
  phase.children = [agent.nodeKey]
  const rows = [root, wf, phase, agent]
  return {
    runs: [{ runId: "r1", label: "r1", status: "running", startedAt: 1, workflows: 1, agentsTotal: 1, agentsDone: 1 }],
    activeRunId: "r1",
    activeTab: "workflow",
    rows,
    listRows: rows,
    listSelectedIndex: 3,
    collapsedNodeKeys: new Set(),
    selectedIndex: 3,
    focus: "tree",
    detailScrollTop: 0,
    selected: agent,
    detail: { node: agent, ancestors: [phase, wf, root], agent: { executions: [], prompt: "做一个侧边栏", result: "ok" } },
    ...over,
  }
}

test("渲染: 空态（无 run）不崩且给出提示", () => {
  const empty: ExplorerViewState = {
    runs: [],
    activeTab: "workflow",
    rows: [],
    listRows: [],
    listSelectedIndex: -1,
    collapsedNodeKeys: new Set(),
    selectedIndex: -1,
    focus: "tree",
    detailScrollTop: 0,
  }
  const lines = renderExplorerBox(empty, 80, 12, theme)
  assert.ok(lines.length > 2)
  assert.ok(lines.join("\n").includes("无 run"))
})

test("渲染: 宽终端双栏 + 窄终端单栏，行宽不超宽", () => {
  for (const width of [120, 80, 40]) {
    const lines = renderExplorerBox(state(), width, 12, theme)
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `行超宽 (${width}): ${visibleWidth(line)} > ${width}`)
    }
    assert.ok(lines.length >= 10, "高度填充稳定")
  }
})

test("渲染: 四个 Tab 都有内容且带选中标记", () => {
  for (const tab of ["workflow", "agents", "tools", "journal"] as const) {
    const lines = renderExplorerFrame(state({ activeTab: tab }), 100, 14, theme)
    const text = lines.join("\n")
    assert.ok(text.includes("[") && text.length > 0)
    if (tab === "agents") assert.ok(text.includes("AgentA"), "Agents Tab 列出 agent")
    if (tab === "tools") assert.ok(text.includes("无工具节点") || text.includes("[tool]"), "Tools Tab 有稳定输出")
  }
})

test("渲染: 收起节点后子行不再出现", () => {
  const expanded = renderExplorerFrame(state(), 100, 14, theme).join("\n")
  const collapsed = renderExplorerFrame(state({ rows: state().rows.slice(0, 2), collapsedNodeKeys: new Set(["wf"]) }), 100, 14, theme).join("\n")
  assert.ok(expanded.includes("AgentA"))
  assert.ok(!collapsed.includes("AgentA"), "折叠后子节点不可见")
})

test("渲染: 详情态显示 prompt/result/attempts", () => {
  const text = renderExplorerFrame(state({ focus: "detail" }), 80, 16, theme).join("\n")
  assert.ok(text.includes("做一个侧边栏"), "prompt 可见")
  assert.ok(text.includes("路径:"), "祖先路径可见")
})

test("wrapByWidth: 中文按列宽硬换行，不产生超宽行", () => {
  const text = "这是一个很长的中文句子用来测试按显示宽度换行的行为是否正确处理双宽字符"
  const lines = wrapByWidth(text, 10)
  assert.ok(lines.length > 1)
  for (const l of lines) assert.ok(visibleWidth(l) <= 10)
  assert.equal(lines.join(""), text, "换行不丢字符")
})
