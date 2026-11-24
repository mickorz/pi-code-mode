/**
 * Explorer Overlay 适配器（M4 TUI 层）。
 *
 * 生命周期分离（架构设计 §3.2）：ctx.ui.custom() 的组件只在面板打开期间存在；
 * Controller / 树模型 / 导航状态常驻于 extension。关闭面板只是 dispose 视图，
 * 再次打开时用原 Controller 恢复选中节点与 Tab。
 *
 * 宿主 API 约束：custom() 的 done() 关闭 overlay，不假设返回可反复 show/hide 的句柄；
 * 因此"关闭指定 overlay"只能靠模块级 activeClose 句柄（全局快捷键 toggle 用）。
 */

import type { ExplorerController } from "../../../../packages/explorer/src/controller/explorer-controller.js"
import { mapKey } from "../commands/workflows/navigator/keys.js"
import { renderExplorerBox, type ThemeLike } from "./render.js"

export interface OpenExplorerOptions {
  /** 打开时定位到指定 run（/explorer <runId>） */
  runId?: string
  /** overlay 宽度（缺省 60%；窄终端调 92%） */
  width?: string
  /** 秒表/流式重绘间隔毫秒（缺省 1000；测试可调小） */
  tickMs?: number
}

/** 当前打开中的 overlay 关闭句柄（模块级单例；同一时刻最多一个面板） */
let activeClose: (() => void) | undefined

/** 是否有面板处于打开态（快捷键 toggle 与测试用） */
export function isExplorerOpen(): boolean {
  return activeClose !== undefined
}

/** 关闭当前面板（无面板时返回 false） */
export function closeExplorer(): boolean {
  const close = activeClose
  if (!close) return false
  activeClose = undefined
  close()
  return true
}

/** 打开 Explorer overlay；Promise 在用户关闭面板后 resolve */
export async function openExplorer(explorer: ExplorerController, ui: any, options: OpenExplorerOptions = {}): Promise<void> {
  if (options.runId) {
    if (!explorer.selectRun(options.runId)) {
      ui.notify(`未找到 run: ${options.runId}（用 /workflows list 查看可用 run）`, "warning")
      return
    }
  }

  const factory = (tui: any, theme: any, _keybindings: unknown, done: () => void) => {
    const close = () => {
      if (activeClose === close) activeClose = undefined
      done()
    }
    activeClose = close
    explorer.open(() => tui.requestRender())

    const themeLike: ThemeLike = {
      fg: (c, s) => (theme?.fg ? theme.fg(c as never, s) : s),
      bg: (c, s) => (theme?.bg ? theme.bg(c as never, s) : s),
      bold: (s) => (theme?.bold ? theme.bold(s) : s),
    }
    const requestRender = () => tui.requestRender()
    const bodyRows = (): number => Math.max(8, Math.floor((tui?.terminal?.rows ?? 24) * 0.9) - 3)

    // 秒表 tick：只在「有运行中节点」时才真的重绘（空闲时是空转检查，无渲染开销）。
    // 运行中节点的耗时按 startedAt 现算，因此需要周期性重绘才能"走字"。
    const tickMs = Math.max(50, options.tickMs ?? 1000)
    const tick = setInterval(() => {
      if (explorer.hasRunningNodes()) requestRender()
    }, tickMs)
    ;(tick as { unref?: () => void }).unref?.()

    /** 原始字节 → 逻辑键 → Controller 导航状态机 */
    const handleKeyData = (data: string): void => {
      // Ctrl+B（0x02）：宿主全局快捷键只挂在 default editor 的 onExtensionShortcut 上，
      // overlay 抢焦点后 editor 拿不到输入 -> 全局 ctrl+b 不会触发。
      // 这里自己拦一次，"面板已打开时再按 ctrl+b 关闭"才能成立（与打开用同一个键）。
      if (data === "") {
        close()
        return
      }
      const key = mapKey(data)
      if (key === "unknown") return
      // j/k 为 up/down 别名（与 Navigator/watch 一致的手感）
      if (key === "j") return handleKeyData("\x1b[B")
      if (key === "k") return handleKeyData("\x1b[A")
      // q / o / esc 都交给 Controller 语义处理：
      //   tree:  q|esc 关闭面板   o 打开详情
      //   detail: q|esc 返回树
      if (key === "r") {
        cycleRun()
        return
      }
      for (const effect of explorer.handleKey(key)) {
        if (effect.kind === "close") {
          close()
          return
        }
        if (effect.kind === "redraw" || effect.kind === "load-detail") requestRender()
      }
    }

    const cycleRun = (): void => {
      const view = explorer.view()
      if (view.runs.length < 2) {
        requestRender()
        return
      }
      const idx = view.runs.findIndex((r) => r.runId === view.activeRunId)
      const next = view.runs[(idx + 1) % view.runs.length]
      if (next) explorer.selectRun(next.runId)
      requestRender()
    }

    return {
      render(width: number): string[] {
        try {
          return renderExplorerBox(explorer.view(), width, bodyRows(), themeLike, {
            // 详情滚动钳制：内容行数只有这里知道（评审修复 M3：End/连续 ↓ 不再越界白屏）
            onDetailMaxScroll: (max) => explorer.noteDetailMaxScroll(max),
            onDetailPageSize: (rows) => explorer.noteDetailPageSize(rows),
          })
        } catch (e) {
          // 渲染自防御：异常不得击穿宿主进程（见 dev-docs/experience/）
          console.error("[pi-code-mode] explorer render 失败:", String((e as Error)?.message ?? e))
          return [`[explorer render 失败] ${String((e as Error)?.message ?? e)}`]
        }
      },
      handleInput(data: string): void {
        handleKeyData(data)
      },
      invalidate(): void {
        // 宿主 Component 契约要求；本组件按需渲染，无需缓存失效
      },
      dispose(): void {
        // 只释放视图，不销毁状态（再次打开要恢复选中节点）
        clearInterval(tick)
        if (activeClose === close) activeClose = undefined
        explorer.hide()
      },
    }
  }

  try {
    await ui.custom(factory, {
      overlay: true,
      // 右侧栏：固定 60% 宽（窄终端内部自动退化为单栏树/详情，renderExplorerFrame 判断）
      overlayOptions: () => ({ width: options.width ?? "60%", maxHeight: "92%", anchor: "right-center", margin: 1 }),
    })
  } finally {
    // 宿主提前销毁 / 正常关闭都不留悬空句柄
    activeClose = undefined
  }
}

/**
 * 全局快捷键（A1）与命令共用的 toggle 入口：已打开 → 关闭；未打开 → 打开。
 * 返回值便于调用方决定是否提示（静默 toggle 更接近 IDE 手感，缺省不提示）。
 */
export async function toggleExplorer(
  explorer: ExplorerController,
  ui: any,
  options: OpenExplorerOptions = {},
): Promise<"opened" | "closed" | "unavailable"> {
  if (closeExplorer()) return "closed"
  if (!ui?.custom) return "unavailable"
  // 不 await：overlay 的 promise 要到用户关闭面板才 resolve，await 会让调用方（快捷键/命令）
  // 一直挂起到面板关闭，返回值语义也就错了
  void openExplorer(explorer, ui, options).catch((e) => {
    console.error("[pi-code-mode] Explorer 打开失败:", String((e as Error)?.message ?? e))
  })
  return "opened"
}
