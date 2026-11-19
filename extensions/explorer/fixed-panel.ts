/**
 * Explorer 固定模式（右侧常驻面板）：设置可开关，Ctrl+B overlay 不动。
 *
 * 设计依据：dev-docs/design/2026-11-19-explorer-fixed-panel-可行性分析.md（2026-11-19 修正版）
 *   - 路线：ctx.ui.custom + overlayOptions { anchor: "right-center", nonCapturing: true }
 *     （官方 API；nonCapturing = 不捕获键盘焦点，主对话输入不受影响；悬浮叠加会遮主区右侧内容）
 *   - 互斥：固定模式 on → 注销 workflow-tasks（其 run 级摘要是树信息的子集）；off → 恢复
 *   - 空态：无 running run 时 render 返回空行集（overlay 零行即视觉不可见）
 *   - 只读：详情走 Ctrl+B overlay（nonCapturing 无键盘交互）
 *
 * 自防御：render 运行在宿主 TUI 渲染循环里，任何异常都返回空行集而不是抛出
 * （workflow-tasks 曾因类型异常击穿宿主，见 pi-code-mode.ts 注释）。
 */

import fs from "node:fs"
import path from "node:path"
import { truncateToWidth } from "@earendil-works/pi-tui"
import type { ExplorerViewState } from "../../src/explorer/controller/explorer-controller.js"
import { depthMapOf, renderTreeRow, type ThemeLike } from "./render.js"

// ── 配置读写（自管配置，同 model-tiers.json 先例；pi settings 是严格 schema 塞不进自定义键） ──

export interface FixedPanelConfig {
  /** 默认 false——不写配置文件 = 关闭，现有用户零感知 */
  enabled: boolean
  /** 右侧锚点：right-top（贴顶）| right-center（垂直居中） */
  anchor: "right-top" | "right-center"
  /** 面板宽度（终端列数；悬浮面板，宽度多少遮多少） */
  width: number
  /** 树行硬上限（超出折叠），防大树占屏 */
  maxRows: number
}

export const FIXED_PANEL_CONFIG_FILE = path.join(".pi", "workflows", "explorer.json")

const DEFAULT_CONFIG: FixedPanelConfig = { enabled: false, anchor: "right-top", width: 34, maxRows: 14 }

/** 读固定模式配置；文件缺失/字段缺失/非法值一律回退默认（enabled 缺省 false）。旧版 placement 字段忽略 */
export function readFixedPanelConfig(cwd: string): FixedPanelConfig {
  const file = path.join(cwd, FIXED_PANEL_CONFIG_FILE)
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { fixedPanel?: Record<string, unknown> }
    const p = raw.fixedPanel ?? {}
    return {
      enabled: p.enabled === true,
      anchor: p.anchor === "right-center" ? "right-center" : "right-top",
      width: typeof p.width === "number" && p.width >= 20 ? Math.floor(p.width) : DEFAULT_CONFIG.width,
      maxRows: typeof p.maxRows === "number" && p.maxRows >= 3 ? Math.floor(p.maxRows) : DEFAULT_CONFIG.maxRows,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** 读-改-写固定模式配置（保留文件内其他键；目录不存在则创建） */
export function writeFixedPanelConfig(cwd: string, patch: Partial<FixedPanelConfig>): FixedPanelConfig {
  const file = path.join(cwd, FIXED_PANEL_CONFIG_FILE)
  const merged = { ...readFixedPanelConfig(cwd), ...patch }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const existing = (() => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    } catch {
      return {}
    }
  })()
  fs.writeFileSync(file, JSON.stringify({ ...existing, fixedPanel: merged }, null, 2) + "\n", "utf8")
  return merged
}

// ── 渲染纯函数（契约测试主对象） ──

/** 折叠尾行文案 */
export function foldLine(total: number): string {
  return `…共 ${total} 节点（Ctrl+B 看全量详情）`
}

/**
 * 固定面板行集：run 头 1 行 + 执行树行（全展开、无选中），超出 maxRows 折叠。
 * 空态策略继承 workflow-tasks：无 running run 时返回空数组——overlay 渲染零行即视觉不可见
 * （run 结束不常驻占屏；终态 run 到 Ctrl+B overlay 查看）。
 * 纯函数：now 注入供测试确定秒表值。
 */
export function fixedPanelLines(view: ExplorerViewState, width: number, maxRows: number, now: number, theme: ThemeLike): string[] {
  if (!view.rows.length || !view.runs.some((r) => r.status === "running")) return []
  const depths = depthMapOf(view.rows)
  const body = view.rows.map((n) => renderTreeRow(n, depths.get(n.nodeKey) ?? 0, width, false, true, theme, now))
  const activeRun = view.runs.find((r) => r.runId === view.activeRunId) ?? view.runs[0]
  const header = activeRun ? `${activeRun.label ?? activeRun.runId}（${activeRun.agentsDone}/${activeRun.agentsTotal}）` : "（无 run）"
  const lines = [header, ...body]
  if (lines.length <= maxRows) return lines.map((l) => truncateToWidth(l, width))
  const shown = lines.slice(0, maxRows - 1).map((l) => truncateToWidth(l, width))
  shown.push(truncateToWidth(`  ${foldLine(lines.length)}`, width))
  return shown
}

// ── 面板侧（overlay 形态）：供互斥协调器编排 ──

export interface OverlayHandleLike {
  hide(): void
}

export interface FixedPanelDeps {
  /** 视图快照来源（ExplorerController.view） */
  getView: () => ExplorerViewState
  /** 秒表重绘判断（ExplorerController.hasRunningNodes） */
  hasRunning: () => boolean
  cwd: string
}

export interface FixedPanelHandle {
  /** 在当前 ctx.ui 上挂右侧 nonCapturing overlay（常驻：不调 done，直到 uninstall） */
  install(ctx: any): void
  /** 隐藏并移除 overlay */
  uninstall(ctx: any): void
}

/**
 * 右侧固定面板：nonCapturing overlay（不抢焦点、常驻、悬浮遮主区右侧）。
 * install 时重读配置（/explorer fixed 切换后 width/anchor 可能已写盘更新）。
 */
export function createFixedPanel(deps: FixedPanelDeps): FixedPanelHandle {
  let handle: OverlayHandleLike | undefined
  return {
    install(ctx: any) {
      const config = readFixedPanelConfig(deps.cwd)
      void (ctx.ui as any).custom(
        (tui: any, theme: unknown, _keybindings: unknown, done: () => void) => {
          const tl = themeLikeOf(theme)
          const render = (width: number): string[] => {
            try {
              return fixedPanelLines(deps.getView(), width, config.maxRows, Date.now(), tl)
            } catch {
              // 自防御：render 异常击穿宿主（同 workflow-tasks 教训），空行集兜底
              return []
            }
          }
          // 秒表走字：仅运行中重绘（空闲零渲染）
          const tick = setInterval(() => {
            if (deps.hasRunning()) tui.requestRender()
          }, FIXED_PANEL_TICK_MS)
          ;(tick as { unref?: () => void }).unref?.()
          return {
            // 宿主 Component 契约；dispose 由宿主在 overlay 移除时调用
            dispose: () => {
              clearInterval(tick)
              done()
            },
            render,
            invalidate: () => {},
          }
        },
        {
          overlay: true,
          overlayOptions: () => ({
            anchor: config.anchor,
            width: config.width,
            maxHeight: "100%",
            margin: { top: 1, right: 0, bottom: 1 },
            // 不捕获键盘焦点：主对话输入不受影响（右侧常驻的关键）
            nonCapturing: true,
            // 窄终端不显示（面板遮主区比例过高）
            visible: (termWidth: number) => termWidth >= 100,
          }),
          onHandle: (h: OverlayHandleLike) => {
            handle = h
          },
        },
      )
    },
    uninstall(_ctx: any) {
      handle?.hide()
      handle = undefined
    },
  }
}

/** 宿主 theme → ThemeLike 适配（工厂收到的 theme 已有 fg/bg/bold，仅收窄类型；异常时恒等兜底） */
export function themeLikeOf(theme: unknown): ThemeLike {
  const t = theme as Partial<ThemeLike> | undefined
  if (typeof t?.fg === "function" && typeof t?.bold === "function") return t as ThemeLike
  return { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s }
}

/** 秒表 tick 间隔（运行中走字；配合空闲零渲染检查） */
export const FIXED_PANEL_TICK_MS = 1000

// ── 互斥协调器 ──

/** workflow-tasks 与固定面板的安装/注销动作（由宿主注入，协调器不关心各自实现） */
export interface WidgetSide {
  install(ctx: unknown): void
  uninstall(ctx: unknown): void
}

export interface WidgetCoordinatorDeps {
  /** 宿主 cwd（配置文件定位） */
  cwd: string
  /** 原版 workflow-tasks 一侧 */
  taskWidget: WidgetSide
  /** 固定面板一侧 */
  fixedPanel: WidgetSide
}

export interface WidgetCoordinator {
  /** 当前固定模式是否开启（配置态） */
  enabled(): boolean
  /** 按当前配置注册正确的一侧（session_start 与命令切换共用；幂等） */
  apply(ctx: unknown): void
  /** 切换固定模式：写回配置文件 + 立即重挂两侧 */
  setEnabled(ctx: unknown, on: boolean): FixedPanelConfig
}

/**
 * 互斥协调器：同一时刻只有一侧在位。
 * - 固定模式 off（默认）→ workflow-tasks（现有行为零变化）
 * - 固定模式 on → 右侧固定面板（workflow-tasks 注销，避免信息重复堆叠）
 */
export function createWidgetCoordinator(deps: WidgetCoordinatorDeps): WidgetCoordinator {
  let config = readFixedPanelConfig(deps.cwd)
  return {
    enabled: () => config.enabled,
    apply(ctx: unknown) {
      if (config.enabled) {
        deps.taskWidget.uninstall(ctx)
        deps.fixedPanel.install(ctx)
      } else {
        deps.fixedPanel.uninstall(ctx)
        deps.taskWidget.install(ctx)
      }
    },
    setEnabled(ctx: unknown, on: boolean) {
      config = writeFixedPanelConfig(deps.cwd, { enabled: on })
      this.apply(ctx)
      return config
    },
  }
}
