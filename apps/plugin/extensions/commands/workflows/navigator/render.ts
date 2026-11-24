/**
 * Navigator 渲染：盒式 overlay（复刻参考项目 renderNavigatorFrame + openWorkflowNavigator 的盒式包装）。
 * 宽度截断用宿主 pi-tui 的 ANSI 感知工具（truncateToWidth/visibleWidth），不自己数可见宽度。
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import type { NavigatorSnapshot } from "./model.js"

/** 结构化主题（宿主 theme 的最小面；缺方法时退化为无色文本，不因主题差异击穿渲染） */
export interface ThemeLike {
  fg(color: string, s: string): string
  bg(color: string, s: string): string
  bold(s: string): string
}

const BOX_BORDER_LEFT = "│ "
const BOX_BORDER_RIGHT = " │"
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length

const VIEW_TITLES: Record<string, string> = {
  runs: "Runs",
  detail: "Runs",
  saved: "Saved",
  savedDetail: "Saved",
}

function statusTag(status: string): string {
  switch (status) {
    case "running":
      return "[RUN]"
    case "completed":
      return "[OK]"
    case "failed":
      return "[FAIL]"
    case "cancelled":
      return "[STOP]"
    default:
      return "[?]"
  }
}

function fmtDuration(ms?: number): string {
  if (ms == null) return ""
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

function fmtTokens(tokens?: number): string {
  return tokens != null ? `${tokens}tok` : ""
}

function fmtTime(ts?: number): string {
  return ts != null ? new Date(ts).toLocaleTimeString() : ""
}

function cursorLine(marker: boolean, line: string): string {
  return `${marker ? "❯ " : "  "}${line}`
}

/** 主渲染：返回盒内正文行（不含边框） */
export function renderNavigatorFrame(s: NavigatorSnapshot, width: number, bodyRows: number, theme: ThemeLike): string[] {
  const lines: string[] = []
  const isRoot = s.view === "runs" || s.view === "saved"

  // 头部：视图 Tab + 过滤指示
  const runsTab = theme.fg(s.view === "runs" || s.view === "detail" ? "accent" : "muted", theme.bold(`Runs(${s.runs.length})`))
  const savedTab = theme.fg(s.view === "saved" || s.view === "savedDetail" ? "accent" : "muted", theme.bold(`Saved(${s.saved.length})`))
  const filterPart = s.filter ? theme.fg("accent", `  filter: ${s.filter}${s.mode === "filter" ? "▌" : ""}`) : ""
  lines.push(truncateToWidth(`${runsTab}  ${savedTab}${filterPart}`, width))

  // 确认横幅（confirm 态置顶显示）
  if (s.confirmPrompt) {
    lines.push(truncateToWidth(theme.fg("accent", theme.bold(`[确认] ${s.confirmPrompt}`)), width))
  }

  if (s.view === "runs" || s.view === "detail") {
    if (!s.runs.length) {
      lines.push(theme.fg("muted", "  （无运行记录——/workflows run <脚本> 发起）"))
    } else if (s.view === "runs") {
      const top = s.scrollTop.runs
      const window = s.runs.slice(top, top + Math.max(1, bodyRows))
      window.forEach((r, i) => {
        const idx = top + i
        const done = r.agents.filter((a) => a.status === "ok").length
        const icon = theme.fg(r.status === "running" ? "accent" : "muted", statusTag(r.status))
        const text = `${icon} ${r.label ?? r.runId}  ${r.runId} (${done}/${r.agents.length})`
        lines.push(cursorLine(idx === s.cursor.runs, truncateToWidth(text, width - 2)))
      })
    } else if (s.detail) {
      const d = s.detail
      lines.push(truncateToWidth(`runId: ${d.runId}  ${statusTag(d.status)} ${d.status}`, width))
      lines.push(truncateToWidth(theme.fg("muted", `启动: ${fmtTime(d.startedAt)}  结束: ${fmtTime(d.finishedAt)}`), width))
      if (d.error) lines.push(truncateToWidth(theme.fg("accent", `错误: ${d.error}`), width))
      lines.push(truncateToWidth(theme.fg("muted", `节点 ${d.agents.length} 个（j/k 滚动，esc 返回）:`), width))
      const rows = Math.max(1, bodyRows - 3)
      const top = s.scrollTop.detail
      const window = d.agents.slice(top, top + rows)
      window.forEach((a, i) => {
        const idx = top + i
        const parts = [`${idx + 1}. ${statusTag(a.status)}`, a.label ?? a.id]
        if (a.phase) parts.push(`(${a.phase})`)
        const dur = fmtDuration(a.durationMs)
        if (dur) parts.push(dur)
        const tok = fmtTokens(a.tokens)
        if (tok) parts.push(tok)
        if (a.replayed) parts.push(theme.fg("muted", "[回放]"))
        lines.push(cursorLine(idx === s.cursor.detail, truncateToWidth(parts.join(" "), width - 2)))
      })
    }
  } else {
    if (!s.saved.length) {
      lines.push(theme.fg("muted", "  （注册表为空——/workflows reg <脚本路径> 注册）"))
    } else if (s.view === "saved") {
      const top = s.scrollTop.saved
      const window = s.saved.slice(top, top + Math.max(1, bodyRows))
      window.forEach((w, i) => {
        const idx = top + i
        const text = `${w.id}${w.description ? `  ${w.description}` : ""}`
        lines.push(cursorLine(idx === s.cursor.saved, truncateToWidth(text, width - 2)))
      })
    } else if (s.savedDetail) {
      const w = s.savedDetail
      lines.push(truncateToWidth(`id: ${w.id}  (name: ${w.name})`, width))
      if (w.description) lines.push(truncateToWidth(`描述: ${w.description}`, width))
      lines.push(truncateToWidth(theme.fg("muted", `脚本: ${w.file}`), width))
      lines.push(truncateToWidth(theme.fg("muted", "执行: /workflows run <id>；u 注销（需确认）"), width))
    }
  }

  // 尾部：按键提示
  const hints =
    s.mode === "filter"
      ? "输入过滤词  enter/esc 返回  backspace 删除"
      : s.mode === "confirm"
        ? "x/u 再按一次执行  esc 取消"
        : isRoot
          ? "j/k 移动  enter 详情  / 过滤  tab 切换  x 停止  u 注销  q 退出"
          : "j/k 滚动  esc 返回  q 退出"
  lines.push(truncateToWidth(theme.fg("muted", hints), width))
  // 填充到固定高度（overlay 盒体高度稳定，不随内容抖动）
  const padded = lines.slice(0, bodyRows)
  while (padded.length < bodyRows) padded.push("")
  return padded
}

/** 盒式包装：上下边框 + 左右边框 + 背景填充（复刻参考项目 overlay 视觉） */
export function renderOverlayBox(s: NavigatorSnapshot, width: number, bodyRows: number, theme: ThemeLike): string[] {
  const inner = Math.max(10, width - BOX_BORDER_OVERHEAD)
  const body = renderNavigatorFrame(s, inner, bodyRows, theme)
  const title = theme.fg("accent", theme.bold(" workflows "))
  const topBorder = `╭─${title}${"─".repeat(Math.max(0, inner - visibleWidth(title) - 1))}╮`
  const botBorder = `╰${"─".repeat(inner + 2)}╯`
  const wrap = (line: string): string => {
    const padded = truncateToWidth(line, inner, "", true)
    const full = BOX_BORDER_LEFT + padded + BOX_BORDER_RIGHT
    return theme.bg("customMessageBg", full + " ".repeat(Math.max(0, width - visibleWidth(full))))
  }
  return [theme.fg("borderMuted", topBorder), ...body.map(wrap), theme.fg("borderMuted", botBorder)]
}
