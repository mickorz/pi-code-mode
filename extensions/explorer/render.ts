/**
 * Explorer TUI 渲染（M4）。
 *
 * 布局：
 *   宽终端（>=110 列）：左侧执行树 + 右侧节点详情双栏
 *   窄终端：单栏；focus=detail 时只显示详情（架构设计 §10.3 的降级要求）
 *
 * 自防御：任何渲染异常都返回错误行而不是抛出——render 运行在宿主 TUI 渲染循环里，
 * 异常会击穿 pi 宿主进程（2026-11-15 实测教训，见 dev-docs/experience/）。
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import type { ExplorerViewState, NodeDetailView } from "../../src/explorer/controller/explorer-controller.js"
import type { WorkflowTreeNode } from "../../src/explorer/model/workflow-tree-model.js"
import type { ExplorerTab } from "../../src/explorer/model/navigation-model.js"

export interface ThemeLike {
  fg(color: string, s: string): string
  bg(color: string, s: string): string
  bold(s: string): string
}

const TAB_LABELS: Array<{ id: ExplorerTab; label: string }> = [
  { id: "workflow", label: "Workflow" },
  { id: "agents", label: "Agents" },
  { id: "tools", label: "Tools" },
  { id: "journal", label: "Journal" },
]

const KIND_ICON: Record<string, string> = {
  run: "*",
  workflow: "#",
  phase: ">",
  agent: "-",
  composite: "+",
  tool: "=",
}

function statusIcon(status: string): string {
  switch (status) {
    case "running":
      return "[RUN]"
    case "ok":
    case "completed":
      return "[OK]"
    case "failed":
    case "error":
      return "[FAIL]"
    case "aborted":
    case "cancelled":
      return "[STOP]"
    default:
      return "[..]"
  }
}

function fmtDuration(ms?: number): string {
  if (ms == null) return ""
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/** 按显示宽度硬换行（中文按 2 列计，交给 visibleWidth） */
export function wrapByWidth(text: string, width: number): string[] {
  const out: string[] = []
  for (const rawLine of String(text).split(/\r?\n/)) {
    if (!rawLine) {
      out.push("")
      continue
    }
    let line = rawLine
    while (visibleWidth(line) > Math.max(1, width)) {
      let cut = line.length
      while (cut > 1 && visibleWidth(line.slice(0, cut)) > width) cut--
      out.push(line.slice(0, cut))
      line = line.slice(cut)
    }
    out.push(line)
  }
  return out
}

/** 树行：缩进 + 展开标记 + 状态 + 标签 */
function renderTreeRow(node: WorkflowTreeNode, depth: number, width: number, selected: boolean, expanded: boolean, theme: ThemeLike): string {
  const marker = node.children.length ? (expanded ? "v" : ">") : " "
  const icon = KIND_ICON[node.kind] ?? "?"
  const dur = fmtDuration(node.durationMs)
  const head = `${"  ".repeat(Math.min(depth, 8))}${marker}${icon} ${statusIcon(node.status)} ${node.label}`
  const tail = dur ? `  ${dur}` : ""
  const text = truncateToWidth(head + tail, width - 2)
  const line = `${selected ? "> " : "  "}${text}`
  return selected ? theme.fg("accent", theme.bold(line)) : line
}

/** 详情面板全量内容行（滚动与切片由调用方负责，以便钳制越界滚动） */
function detailLinesOf(d: NodeDetailView | undefined, width: number, theme: ThemeLike): string[] {
  if (!d) return [theme.fg("muted", "  （未选中节点）")]
  const { node } = d
  const lines: string[] = []
  lines.push(truncateToWidth(`${statusIcon(node.status)} ${node.label}`, width))
  lines.push(truncateToWidth(theme.fg("muted", `kind=${node.kind}  scope=${node.scopePath.join("/") || "-"}`), width))
  const meta: string[] = []
  if (node.durationMs != null) meta.push(`耗时 ${fmtDuration(node.durationMs)}`)
  if (node.metadata?.model) meta.push(`模型 ${node.metadata.model}`)
  if (node.metadata?.tokens != null) meta.push(`tokens ${node.metadata.tokens}`)
  if (node.metadata?.attempt != null) meta.push(`attempt ${node.metadata.attempt}`)
  if (node.metadata?.replayed) meta.push("[回放]")
  if (meta.length) lines.push(truncateToWidth(meta.join("  "), width))
  if (node.metadata?.error) {
    lines.push(...wrapByWidth(theme.fg("accent", `错误: ${node.metadata.error}`), width).map((l) => truncateToWidth(l, width)))
  }
  if (d.ancestors.length) {
    lines.push(truncateToWidth(theme.fg("muted", `路径: ${d.ancestors.map((a) => a.label).reverse().join(" / ")}`), width))
  }
  if (d.agent) {
    const a = d.agent
    if (a.prompt) {
      lines.push(theme.fg("muted", "-- prompt --"))
      lines.push(...wrapByWidth(a.prompt, width).slice(0, 8).map((l) => truncateToWidth(l, width)))
    }
    if (a.result !== undefined) {
      lines.push(theme.fg("muted", "-- result --"))
      const text = typeof a.result === "string" ? a.result : JSON.stringify(a.result, null, 2)
      lines.push(...wrapByWidth(text ?? "", width).slice(0, 10).map((l) => truncateToWidth(l, width)))
    }
    if (a.executions.length) {
      lines.push(theme.fg("muted", `-- attempts (${a.executions.length}) --`))
      for (const e of a.executions.slice(-5)) {
        lines.push(truncateToWidth(`  #${e.attempt} ${statusIcon(e.status)} ${fmtDuration(e.durationMs)}${e.error ? ` ${e.error.slice(0, 40)}` : ""}`, width))
      }
    }
  }
  return lines
}

/** 详情视口：把全量内容按 clamp 后的起点切片，并回报最大滚动起点 */
function renderDetail(
  d: NodeDetailView | undefined,
  width: number,
  scrollTop: number,
  bodyRows: number,
  theme: ThemeLike,
  onMaxScroll?: (maxStart: number) => void,
): string[] {
  const lines = detailLinesOf(d, width, theme)
  const maxStart = Math.max(0, lines.length - Math.max(1, bodyRows))
  onMaxScroll?.(maxStart)
  const start = Math.min(Math.max(0, scrollTop), maxStart)
  const view = lines.slice(start, start + Math.max(1, bodyRows))
  while (view.length < bodyRows) view.push("")
  return view
}

/** Tab 列表行（带选中标记；listRows 是全树过滤，不受树折叠影响） */
function tabListRow(text: string, selected: boolean, width: number, theme: ThemeLike): string {
  const line = `${selected ? "> " : "  "}${text}`
  return truncateToWidth(selected ? theme.fg("accent", theme.bold(line)) : line, width)
}

function renderAgentsTab(state: ExplorerViewState, width: number, bodyRows: number, theme: ThemeLike): string[] {
  const agents = (state.listRows ?? state.rows).filter((r) => r.kind === "agent")
  if (!agents.length) return [theme.fg("muted", "  （无 Agent 节点）")]
  return agents.slice(0, bodyRows).map((a, idx) => {
    const parts = [statusIcon(a.status), a.label, fmtDuration(a.durationMs)]
    if (a.metadata?.model) parts.push(a.metadata.model)
    if (a.metadata?.tokens != null) parts.push(`${a.metadata.tokens}tok`)
    if (a.metadata?.replayed) parts.push("[回放]")
    return tabListRow(parts.filter(Boolean).join("  "), idx === state.listSelectedIndex, width, theme)
  })
}

function renderToolsTab(state: ExplorerViewState, width: number, bodyRows: number, theme: ThemeLike): string[] {
  const tools = (state.listRows ?? state.rows).filter((r) => r.kind === "tool")
  if (!tools.length) return [theme.fg("muted", "  （无工具节点——runTool / MCP 调用会出现在这里）")]
  return tools
    .slice(0, bodyRows)
    .map((t, idx) => tabListRow(`${statusIcon(t.status)} ${t.label}  ${fmtDuration(t.durationMs)}`, idx === state.listSelectedIndex, width, theme))
}

function renderJournalTab(state: ExplorerViewState, width: number, bodyRows: number, theme: ThemeLike): string[] {
  const agents = (state.listRows ?? state.rows).filter((r) => r.kind === "agent")
  const lines: string[] = []
  for (const [idx, a] of agents.entries()) {
    lines.push(tabListRow(`${a.label}  ${statusIcon(a.status)}${a.metadata?.replayed ? "  [replayed]" : ""}`, idx === state.listSelectedIndex, width, theme))
    const detail = state.detail?.node.nodeKey === a.nodeKey ? state.detail : undefined
    for (const e of detail?.agent?.executions ?? []) {
      lines.push(truncateToWidth(`  #${e.attempt} ${statusIcon(e.status)} ${fmtDuration(e.durationMs)}${e.error ? `  ${e.error.slice(0, 60)}` : ""}`, width))
    }
  }
  if (!lines.length) return [theme.fg("muted", "  （无执行历史）")]
  return lines.slice(0, bodyRows)
}

export interface RenderHooks {
  /** 详情内容最大滚动起点（渲染层才知道内容行数）；Controller 用它钳制 End/↓ */
  onDetailMaxScroll?: (maxStart: number) => void
}

/** 主渲染：返回 overlay 正文行（不含边框） */
export function renderExplorerFrame(
  state: ExplorerViewState,
  width: number,
  bodyRows: number,
  theme: ThemeLike,
  hooks: RenderHooks = {},
): string[] {
  const lines: string[] = []

  // Tab 栏 + 当前 run
  const tabs = TAB_LABELS.map((t) => (t.id === state.activeTab ? theme.fg("accent", theme.bold(`[${t.label}]`)) : theme.fg("muted", ` ${t.label} `))).join("")
  const runRow = state.runs.find((r) => r.runId === state.activeRunId)
  const runText = runRow ? `  ${statusIcon(runRow.status)} ${runRow.label ?? runRow.runId} (${runRow.agentsDone}/${runRow.agentsTotal})` : "  （无 run）"
  lines.push(truncateToWidth(`${tabs}${runText}`, width))

  const hintRow = state.runs.length > 1 ? theme.fg("muted", `runs ${state.runs.length} 个（o 切换）`) : ""
  if (hintRow) lines.push(truncateToWidth(hintRow, width))

  const bodyHeight = Math.max(4, bodyRows - lines.length - 1)
  const wide = width >= 110

  if (state.activeTab !== "workflow") {
    const body =
      state.activeTab === "agents"
        ? renderAgentsTab(state, width, bodyHeight, theme)
        : state.activeTab === "tools"
          ? renderToolsTab(state, width, bodyHeight, theme)
          : renderJournalTab(state, width, bodyHeight, theme)
    lines.push(...body)
  } else if (wide) {
    const leftWidth = Math.max(32, Math.floor(width * 0.52))
    const rightWidth = Math.max(20, width - leftWidth - 1)
    const depthMap = depthMapOf(state.rows)
    const treeLines = state.rows.map((node, idx) =>
      renderTreeRow(node, depthMap.get(node.nodeKey) ?? 0, leftWidth, idx === state.selectedIndex && state.focus === "tree", !state.collapsedNodeKeys.has(node.nodeKey), theme),
    )
    const detailLines = renderDetail(state.detail, rightWidth, state.detailScrollTop, bodyHeight, theme, hooks.onDetailMaxScroll)
    const start = treeWindowStart(state, bodyHeight)
    for (let i = 0; i < bodyHeight; i++) {
      const l = treeLines[start + i] ?? ""
      const r = detailLines[i] ?? ""
      lines.push(`${truncateToWidth(l, leftWidth, "", true)}${theme.fg("borderMuted", "|")}${truncateToWidth(r, rightWidth, "", true)}`)
    }
  } else if (state.focus === "detail") {
    lines.push(...renderDetail(state.detail, width, state.detailScrollTop, bodyHeight, theme, hooks.onDetailMaxScroll))
  } else {
    const depthMap = depthMapOf(state.rows)
    const start = treeWindowStart(state, bodyHeight)
    const slice = state.rows.slice(start, start + bodyHeight)
    slice.forEach((node, i) => {
      const idx = start + i
      lines.push(renderTreeRow(node, depthMap.get(node.nodeKey) ?? 0, width, idx === state.selectedIndex, !state.collapsedNodeKeys.has(node.nodeKey), theme))
    })
  }

  const fullHints =
    state.activeTab === "workflow"
      ? state.focus === "detail"
        ? "up/down 滚动  left/right 上下节点  esc 返回树  tab 切 Tab  ctrl+b/q 关闭"
        : "up/down 选择  right/enter 展开或详情  left 收起  tab 切 Tab  o 切 run  ctrl+b/q 关闭"
      : "tab 切 Tab  ctrl+b/q 关闭"
  // 窄终端换短提示，不依赖截断（截断会丢掉关键键位信息）
  const shortHints =
    state.activeTab !== "workflow" ? "tab / ^B" : state.focus === "detail" ? "↑↓ 滚动  ←→ 节点  esc 返回  ^B" : "↑↓ 选择  →/enter 详情  ← 收起  ^B"
  const hints = visibleWidth(fullHints) <= width ? fullHints : shortHints
  lines.push(truncateToWidth(theme.fg("muted", hints), width))

  const padded = lines.slice(0, bodyRows)
  while (padded.length < bodyRows) padded.push("")
  return padded
}

/** 树窗口滚动起点：保证选中行在可见区域内 */
function treeWindowStart(state: ExplorerViewState, bodyRows: number): number {
  if (state.selectedIndex < 0) return 0
  if (state.selectedIndex < bodyRows) return 0
  return state.selectedIndex - bodyRows + 1
}

/** 行深度：沿 parentKey 向上数层（可见行里父节点必在，折叠会剪掉子树） */
function depthMapOf(rows: WorkflowTreeNode[]): Map<string, number> {
  const byKey = new Map(rows.map((r) => [r.nodeKey, r]))
  const depths = new Map<string, number>()
  for (const row of rows) {
    let depth = 0
    let cur = row.parentKey
    while (cur && byKey.has(cur) && depth < 12) {
      depth++
      cur = byKey.get(cur)?.parentKey
    }
    depths.set(row.nodeKey, depth)
  }
  return depths
}

const BOX_LEFT = "| "
const BOX_RIGHT = " |"

/** 盒式包装（右侧栏视觉；宽度自适应） */
export function renderExplorerBox(
  state: ExplorerViewState,
  width: number,
  bodyRows: number,
  theme: ThemeLike,
  hooks: RenderHooks = {},
): string[] {
  const inner = Math.max(20, width - BOX_LEFT.length - BOX_RIGHT.length)
  const body = renderExplorerFrame(state, inner, bodyRows, theme, hooks)
  const title = theme.fg("accent", theme.bold(" Workflow Explorer "))
  const top = `+-${title}${"-".repeat(Math.max(0, inner - visibleWidth(title) - 1))}+`
  const bottom = `+${"-".repeat(inner + 2)}+`
  const wrap = (line: string): string => {
    const padded = truncateToWidth(line, inner, "", true)
    const full = BOX_LEFT + padded + BOX_RIGHT
    return theme.bg("customMessageBg", full + " ".repeat(Math.max(0, width - visibleWidth(full))))
  }
  return [theme.fg("borderMuted", top), ...body.map(wrap), theme.fg("borderMuted", bottom)]
}
