/**
 * Explorer TUI 渲染（交互模型对齐 REF-001）。
 *
 * 布局：**单树与全屏详情两态满屏切换**，无 Tab、无左右分栏。
 *   view=tree   -> 整屏执行树（opencode 侧栏树的等价物）
 *   view=detail -> 整屏节点详情（opencode 的 node detail route 等价物）
 *
 * 自防御：任何渲染异常都返回错误行而不是抛出——render 运行在宿主 TUI 渲染循环里，
 * 异常会击穿 pi 宿主进程（详见 dev-docs/experience/）。
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import type { ExplorerViewState, NodeDetailView } from "../../src/explorer/controller/explorer-controller.js"
import type { WorkflowTreeNode } from "../../src/explorer/model/workflow-tree-model.js"
import { resolveResultState } from "../../src/explorer/repository/result-view.js"

export interface ThemeLike {
  fg(color: string, s: string): string
  bg(color: string, s: string): string
  bold(s: string): string
}

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

/** 树行时长：运行中按 startedAt 现算（配合 tick 每秒增长），终态用 durationMs */
function rowDuration(node: WorkflowTreeNode, now: number): string {
  if (node.status === "running") {
    const from = node.startedAt
    if (from == null) return ""
    return `${((now - from) / 1000).toFixed(1)}s`
  }
  return fmtDuration(node.durationMs)
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
  const dur = rowDuration(node, Date.now())
  const head = `${"  ".repeat(Math.min(depth, 8))}${marker}${icon} ${statusIcon(node.status)} ${node.label}`
  const tail = dur ? `  ${dur}` : ""
  const text = truncateToWidth(head + tail, width - 2)
  const line = `${selected ? "> " : "  "}${text}`
  return selected ? theme.fg("accent", theme.bold(line)) : line
}

/** 详情全量内容行（滚动与切片由调用方负责，以便钳制越界滚动） */
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
  if (node.metadata?.outputType) meta.push(`输出 ${node.metadata.outputType}`)
  if (meta.length) lines.push(truncateToWidth(meta.join("  "), width))
  // agent/tool 的错误在下方结果区统一呈现（避免同一个错误打两遍）
  if (node.metadata?.error && node.kind !== "agent" && node.kind !== "tool") {
    lines.push(...wrapByWidth(theme.fg("accent", `错误: ${node.metadata.error}`), width).map((l) => truncateToWidth(l, width)))
  }
  if (d.ancestors.length) {
    lines.push(truncateToWidth(theme.fg("muted", `路径: ${d.ancestors.map((a) => a.label).reverse().join(" / ")}`), width))
  }
  if (d.agent?.prompt) {
    lines.push(theme.fg("muted", "-- prompt --"))
    lines.push(...wrapByWidth(d.agent.prompt, width).slice(0, 8).map((l) => truncateToWidth(l, width)))
  }
  // 结果区：agent 与 tool 节点都渲染（对齐 REF-001 的空态三分 + 脱敏 + 20KB 截断提示）
  if (node.kind === "agent" || node.kind === "tool") {
    const resultState = resolveResultState({
      status: node.status,
      error: node.metadata?.error,
      result: d.agent?.result,
      outputType: d.agent?.outputType,
      outputPreview: node.metadata?.outputPreview,
    })
    lines.push(theme.fg("muted", "-- result --"))
    const live = node.status === "running" ? node.metadata?.partialOutput : undefined
    if (live) {
      // 流式尾部（B）：只显示最后若干行，避免长输出把详情撑爆
      const liveLines = wrapByWidth(live, width)
      const shown = liveLines.slice(-12)
      lines.push(theme.fg("muted", `  （实时输出，未完成 · 尾部 ${(Buffer.byteLength(live, "utf8") / 1024).toFixed(1)}KB）`))
      lines.push(...shown.map((l) => truncateToWidth(l, width)))
    } else if (resultState.state === "error") {
      lines.push(...wrapByWidth(theme.fg("accent", `错误: ${resultState.message}`), width).map((l) => truncateToWidth(l, width)))
    } else if (resultState.state === "pending") {
      lines.push(theme.fg("muted", "  （运行中，暂无结果）"))
    } else if (resultState.state === "empty") {
      lines.push(theme.fg("muted", "  （无结果返回）"))
    } else {
      if (resultState.source === "preview") {
        lines.push(theme.fg("muted", "  （快照预览，journal 未写入完整结果）"))
      }
      lines.push(...wrapByWidth(resultState.view.body, width).map((l) => truncateToWidth(l, width)))
      if (resultState.view.truncated) {
        lines.push(theme.fg("muted", `  （结果已截断，原始 ${(resultState.view.originalBytes / 1024).toFixed(1)} KB）`))
      }
    }
  }
  if (d.agent) {
    const a = d.agent
    if (a.executions.length) {
      lines.push(theme.fg("muted", `-- attempts (${a.executions.length}) --`))
      for (const e of a.executions.slice(-5)) {
        lines.push(truncateToWidth(`  #${e.attempt} ${statusIcon(e.status)} ${fmtDuration(e.durationMs)}${e.error ? ` ${e.error.slice(0, 40)}` : ""}`, width))
      }
    }
  }
  return lines
}

/** 详情视口：按 clamp 后的起点切片，并回报最大滚动起点 */
function renderDetail(
  d: NodeDetailView | undefined,
  width: number,
  scrollTop: number,
  bodyRows: number,
  theme: ThemeLike,
  onMaxScroll?: (maxStart: number) => void,
  onPageSize?: (rows: number) => void,
): string[] {
  const lines = detailLinesOf(d, width, theme)
  onPageSize?.(Math.max(1, bodyRows))
  const maxStart = Math.max(0, lines.length - Math.max(1, bodyRows))
  onMaxScroll?.(maxStart)
  const start = Math.min(Math.max(0, scrollTop), maxStart)
  const view = lines.slice(start, start + Math.max(1, bodyRows))
  while (view.length < bodyRows) view.push("")
  return view
}

export interface RenderHooks {
  /** 详情内容最大滚动起点（渲染层才知道内容行数）；Controller 用它钳制 End/PgDn */
  onDetailMaxScroll?: (maxStart: number) => void
  /** 视口行数（翻页步长，PgUp/PgDn 用） */
  onDetailPageSize?: (rows: number) => void
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

  // 头部：当前 run（无 Tab 栏）
  const runRow = state.runs.find((r) => r.runId === state.activeRunId)
  const runText = runRow
    ? `${statusIcon(runRow.status)} ${runRow.label ?? runRow.runId} (${runRow.agentsDone}/${runRow.agentsTotal})`
    : "（无 run）"
  const runSwitch = state.runs.length > 1 ? theme.fg("muted", `  · runs ${state.runs.length}（r 切换）`) : ""
  lines.push(truncateToWidth(`${runText}${runSwitch}`, width))

  const bodyHeight = Math.max(4, bodyRows - lines.length - 1)

  if (state.view === "detail") {
    lines.push(...renderDetail(state.detail, width, state.detailScrollTop, bodyHeight, theme, hooks.onDetailMaxScroll, hooks.onDetailPageSize))
  } else {
    const depthMap = depthMapOf(state.rows)
    const start = treeWindowStart(state, bodyHeight)
    const slice = state.rows.slice(start, start + bodyHeight)
    slice.forEach((node, i) => {
      const idx = start + i
      lines.push(renderTreeRow(node, depthMap.get(node.nodeKey) ?? 0, width, idx === state.selectedIndex, !state.collapsedNodeKeys.has(node.nodeKey), theme))
    })
    if (!state.rows.length) lines.push(theme.fg("muted", "  （无节点——执行 workflow 后这里会出现执行树）"))
  }

  // 底部键位提示（对齐 opencode：up/k、down/j、enter 展开、o 详情、esc/q 返回）
  const fullHints =
    state.view === "detail"
      ? "PgUp/PgDn 滚动  ←/→ 上/下一个节点  ↑/esc/q 返回树  ^B 关闭"
      : "↑/k ↓/j 选择  PgUp/PgDn 翻页  → 展开  ← 收起  enter/o 详情  esc/q 关闭"
  const shortHints = state.view === "detail" ? "PgUp/Dn 滚动  ←→ 节点  ↑ 返回" : "↑↓ 选择  → 展开  enter 详情  q 退出"
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

/** 盒式包装（宽度自适应） */
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
