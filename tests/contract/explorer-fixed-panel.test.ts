/**
 * Explorer 固定模式契约测试（dev-docs/design/2026-11-19-explorer-fixed-panel-可行性分析.md）
 *
 * 覆盖：
 *  - 配置读写 roundtrip + 默认值 + 非法值回退
 *  - 渲染纯函数：无 running run 空行集（空态策略继承 workflow-tasks）、行内容、maxRows 折叠
 *  - 互斥协调器：on → 注销 workflow-tasks 挂固定面板；off → 反之；幂等 apply
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  readFixedPanelConfig,
  writeFixedPanelConfig,
  fixedPanelLines,
  foldLine,
  createWidgetCoordinator,
  themeLikeOf,
  type FixedPanelConfig,
  type WidgetSide,
} from "../../extensions/explorer/fixed-panel.js"
import type { ExplorerViewState, NodeDetailView } from "../../src/explorer/controller/explorer-controller.js"
import type { WorkflowTreeNode } from "../../src/explorer/model/workflow-tree-model.js"

const identityTheme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s }

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fixed-panel-test-"))
}

function treeNode(partial: Partial<WorkflowTreeNode> & { nodeKey: string; label: string }): WorkflowTreeNode {
  return {
    runId: "r1",
    kind: "agent",
    status: "ok",
    scopePath: ["root"],
    children: [],
    createdSequence: 0,
    updatedSequence: 0,
    ...partial,
  }
}

/** 构造「一个 running run + N 个节点」的视图状态 */
function viewState(nodeCount: number, running = true): ExplorerViewState {
  const runRow = { runId: "r1", label: "demo_run", status: running ? ("running" as const) : ("completed" as const), startedAt: 1, workflows: 1, agentsTotal: nodeCount, agentsDone: running ? 1 : nodeCount }
  const run = treeNode({ nodeKey: "run", kind: "run", label: "r1", scopePath: [] })
  const rows: WorkflowTreeNode[] = [run]
  for (let i = 0; i < nodeCount; i++) {
    const child = treeNode({ nodeKey: `n${i}`, parentKey: "run", kind: "agent", label: `Agent${i}`, scopePath: ["root"] })
    run.children.push(child.nodeKey)
    rows.push(child)
  }
  return {
    runs: [runRow],
    activeRunId: "r1",
    view: "tree",
    rows,
    collapsedNodeKeys: new Set(),
    selectedIndex: -1,
    detailScrollTop: 0,
  }
}

// ── 配置 ──

test("配置: 缺省（无文件）为关闭 + top-right + width 34 + maxRows 14", () => {
  const dir = tmpDir()
  const cfg = readFixedPanelConfig(dir)
  assert.deepEqual(cfg, { enabled: false, anchor: "top-right", width: 34, maxRows: 14 })
})

test("配置: roundtrip 写读一致，保留文件内其他键", () => {
  const dir = tmpDir()
  const file = path.join(dir, ".pi", "workflows", "explorer.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ other: 123, fixedPanel: { enabled: false } }), "utf8")

  const merged = writeFixedPanelConfig(dir, { enabled: true, anchor: "right-center", width: 40, maxRows: 6 })
  assert.equal(merged.enabled, true)
  assert.deepEqual(readFixedPanelConfig(dir), { enabled: true, anchor: "right-center", width: 40, maxRows: 6 } satisfies FixedPanelConfig)
  // 其他键不丢
  assert.equal((JSON.parse(fs.readFileSync(file, "utf8")) as any).other, 123)
})

test("配置: 非法值回退默认；旧配置的非法 right-top 自动归位 top-right（无需用户改文件）", () => {
  const dir = tmpDir()
  const file = path.join(dir, ".pi", "workflows", "explorer.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // right-top：pi-tui OverlayAnchor 无此值（初版默认值笔误，NaN 定位致零绘制）
  fs.writeFileSync(
    file,
    JSON.stringify({ fixedPanel: { enabled: true, anchor: "right-top" } }),
    "utf8",
  )
  assert.deepEqual(readFixedPanelConfig(dir), { enabled: true, anchor: "top-right", width: 34, maxRows: 14 })
})

test("配置: 非法值回退默认（enabled 非 true 一律关、anchor 白名单（right-top 归位 top-right）、width/maxRows 下限）；旧 placement 字段忽略", () => {
  const dir = tmpDir()
  const file = path.join(dir, ".pi", "workflows", "explorer.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({ fixedPanel: { enabled: "yes", anchor: "leftDock", width: 5, maxRows: -5, placement: "aboveEditor" } }),
    "utf8",
  )
  assert.deepEqual(readFixedPanelConfig(dir), { enabled: false, anchor: "top-right", width: 34, maxRows: 14 })
})

// ── 渲染 ──

test("渲染: 常驻语义——无 running run 也显示（终态树不隐藏）", () => {
  const lines = fixedPanelLines(viewState(3, false), 80, 10, 5000, identityTheme)
  assert.ok(lines.length > 0, "常驻面板不应随 run 结束隐藏")
  assert.ok(lines[0].includes("demo_run"), `头行应显示最近 run：${lines[0]}`)
})

test("渲染: 完全无数据时显示占位提示（不隐藏）", () => {
  const v = viewState(0, false)
  v.runs = []
  v.rows = []
  const lines = fixedPanelLines(v, 80, 10, 5000, identityTheme)
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes("无在途 workflow"), `头行应为占位：${lines[0]}`)
  assert.ok(lines[1].includes("workflow 运行时这里显示执行树"), `应有占位提示：${lines[1]}`)
})

test("渲染: 有 running run 输出 run 头 + 执行树行（run 节点也是一行），节点行带图标与状态", () => {
  const lines = fixedPanelLines(viewState(3, true), 80, 10, 5000, identityTheme)
  assert.equal(lines[0], "demo_run（1/3）")
  // 1 头 + 1 run 节点行 + 3 agent 行
  assert.equal(lines.length, 5)
  assert.ok(lines[1].includes("[OK]"), `run 行应有状态图标：${lines[1]}`)
  assert.ok(lines[2].includes("Agent0"), `agent 行应有 label：${lines[2]}`)
})

test("渲染: 超出 maxRows 折叠为 …共 N 节点 尾行", () => {
  // nodeCount=10 → 头 1 + run 1 + agent 10 = 12 行；maxRows=4 → 头 + 2 节点 + 折叠
  const lines = fixedPanelLines(viewState(10, true), 80, 4, 5000, identityTheme)
  assert.equal(lines.length, 4)
  assert.ok(lines[3].includes(foldLine(12)), `折叠行应标注总行数：${lines[3]}`)
})

test("渲染: runs 空但 rows 非空仍显示树（常驻，runs 数据缺失不阻断）", () => {
  const v = viewState(2, true)
  v.runs = []
  const lines = fixedPanelLines(v, 80, 10, 5000, identityTheme)
  assert.ok(lines.length > 0)
  assert.ok(lines[0].includes("无在途 workflow"))
})

// ── 互斥协调器 ──

function fakeSides(): { task: WidgetSide; fixed: WidgetSide; log: string[] } {
  const log: string[] = []
  const mk = (name: string): WidgetSide => ({
    install: () => log.push(`${name}:install`),
    uninstall: () => log.push(`${name}:uninstall`),
  })
  return { task: mk("task"), fixed: mk("fixed"), log }
}

test("互斥: 默认 off → task 在位；on → task 注销 fixed 挂载；切回 off 恢复 task", () => {
  const dir = tmpDir()
  const { task, fixed, log } = fakeSides()
  const coord = createWidgetCoordinator({ cwd: dir, taskWidget: task, fixedPanel: fixed })

  assert.equal(coord.enabled(), false)
  const ctx = {}
  coord.apply(ctx)
  assert.deepEqual(log, ["fixed:uninstall", "task:install"])

  coord.setEnabled(ctx, true)
  assert.equal(coord.enabled(), true)
  assert.deepEqual(log, ["fixed:uninstall", "task:install", "task:uninstall", "fixed:install"])
  // 配置已写盘
  assert.equal(readFixedPanelConfig(dir).enabled, true)

  coord.setEnabled(ctx, false)
  assert.equal(readFixedPanelConfig(dir).enabled, false)
})

test("互斥: 重复 apply 不产生另一侧 install（两侧不同时在位）", () => {
  const dir = tmpDir()
  const { task, fixed, log } = fakeSides()
  const coord = createWidgetCoordinator({ cwd: dir, taskWidget: task, fixedPanel: fixed })
  const ctx = {}
  // off 态重复 apply：fixed:install 永不出现（宿主 setWidget 同 key 覆盖幂等，重复挂载无害）
  coord.apply(ctx)
  coord.apply(ctx)
  assert.ok(!log.includes("fixed:install"), `off 态不应挂固定面板：${log.join(",")}`)
  // on 态重复 apply：task:install 永不出现
  coord.setEnabled(ctx, true)
  coord.apply(ctx)
  const sinceOn = log.slice(log.lastIndexOf("fixed:install"))
  assert.ok(!sinceOn.includes("task:install"), `on 态不应挂 workflow-tasks：${sinceOn.join(",")}`)
})

// ── theme 适配 ──

test("themeLikeOf: 无 fg/bold 的 theme 回退恒等实现", () => {
  const t = themeLikeOf({})
  assert.equal(t.fg("accent", "x"), "x")
  const real = { fg: (c: string, s: string) => `<${c}>${s}`, bg: (_c: string, s: string) => s, bold: (s: string) => s }
  assert.equal(themeLikeOf(real).fg("accent", "x"), "<accent>x")
})

// 占位引用（避免 NodeDetailView 未使用告警；详情渲染属于 overlay，不在固定面板范围）
export type { NodeDetailView }
