/**
 * Explorer 布局预览（开发期沙盒）：把真实渲染结果打到 stdout，用于目视核对宽/窄终端布局。
 *
 * 用法：npx tsx dev-examples/explorer-preview/render-preview.mts [宽度] [行数] [tab]
 * 说明：纯渲染预览，不连接 runtime；数据是构造的执行树样例。
 */

import { renderExplorerBox } from "../../extensions/explorer/render.js"
import type { ExplorerViewState } from "../../src/explorer/controller/explorer-controller.js"
import type { WorkflowTreeNode } from "../../src/explorer/model/workflow-tree-model.js"

const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s }

function n(nodeKey: string, kind: WorkflowTreeNode["kind"], label: string, status: string, parentKey?: string, over: Partial<WorkflowTreeNode> = {}): WorkflowTreeNode {
  return {
    nodeKey,
    runId: "run-demo",
    kind,
    label,
    status,
    scopePath: kind === "run" ? [] : kind === "workflow" ? ["root"] : ["root"],
    parentKey,
    children: [],
    createdSequence: 0,
    updatedSequence: 0,
    ...over,
  }
}

const run = n("run", "run", "run-demo", "running")
const wf = n("wf", "workflow", "杭州麻将需求分析", "running", "run")
const ph1 = n("ph1", "phase", "需求提取", "ok", "wf", { durationMs: 18200 })
const a1 = n("a1", "agent", "AgentA 提取原始需求", "ok", "ph1", { durationMs: 12000, metadata: { model: "p/fast", tokens: 820, attempt: 1 } })
const a2 = n("a2", "agent", "AgentB 补充边界条件", "ok", "ph1", { durationMs: 18200, metadata: { tokens: 640 } })
const ph2 = n("ph2", "phase", "规则分析", "running", "wf", { durationMs: 32400 })
const child = n("child", "workflow", "ChildA 结算规则子流程", "running", "ph2")
const ph3 = n("ph3", "phase", "▸ ChildA / 结算分析", "running", "child", { durationMs: 21000 })
const a3 = n("a3", "agent", "AgentC 结算公式分析", "ok", "ph3", { durationMs: 21000, metadata: { model: "p/pro", tokens: 1520 } })
const a4 = n("a4", "agent", "AgentD 服务端一致性核对", "running", "ph3", { durationMs: 8400, metadata: { model: "p/pro", attempt: 2 } })
const tool = n("tool", "tool", "[tool] check_rule.py", "ok", "ph3", { durationMs: 320 })
const ph4 = n("ph4", "phase", "报告生成", "pending", "wf")

run.children = ["wf"]
wf.children = ["ph1", "ph2", "ph4"]
ph1.children = ["a1", "a2"]
ph2.children = ["child"]
child.children = ["ph3"]
ph3.children = ["a3", "a4", "tool"]

const rows = [run, wf, ph1, a1, a2, ph2, child, ph3, a3, a4, tool, ph4]

const state: ExplorerViewState = {
  runs: [
    { runId: "run-demo", label: "杭州麻将需求分析", status: "running", startedAt: Date.now() - 52000, workflows: 2, agentsTotal: 4, agentsDone: 2 },
    { runId: "run-prev", label: "上一轮（已完成）", status: "completed", startedAt: Date.now() - 900000, finishedAt: Date.now() - 800000, workflows: 1, agentsTotal: 3, agentsDone: 3 },
  ],
  activeRunId: "run-demo",
  activeTab: "workflow",
  rows,
  listRows: rows,
  listSelectedIndex: 8,
  collapsedNodeKeys: new Set(),
  selectedIndex: 8,
  focus: "tree",
  detailScrollTop: 0,
  selected: a3,
  detail: {
    node: a3,
    ancestors: [ph3, child, ph2, wf, run],
    agent: {
      prompt: "分析结算公式：自摸/点炮/杠/番数的计算规则，并与服务端实现逐条对照。",
      result: "已核对 12 条规则，其中 2 条存在差异（杠上开花番数、包牌分摊）。",
      model: "p/pro",
      durationMs: 21000,
      executions: [
        { executionId: "x1", attempt: 1, status: "failed", error: "timeout", durationMs: 30000 },
        { executionId: "x2", attempt: 2, status: "ok", durationMs: 21000 },
      ],
    },
  },
}

// 可选：第 3 个参数指定 Tab（workflow|agents|tools|journal），默认 workflow
const tabArg = (process.argv[4] ?? process.env.EXPLORER_TAB ?? "workflow") as ExplorerViewState["activeTab"]
state.activeTab = tabArg

const width = Number(process.argv[2] ?? 76)
const bodyRows = Number(process.argv[3] ?? 22)
console.log(`\n=== 宽度 ${width}（内宽 ${width - 4}）：${width - 4 >= 110 ? "双栏" : "单栏"} ===\n`)
console.log(renderExplorerBox(state, width, bodyRows, theme).join("\n"))
