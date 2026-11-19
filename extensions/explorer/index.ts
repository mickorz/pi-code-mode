/**
 * Explorer Overlay 适配器（M4 TUI 层）。
 *
 * 生命周期分离（架构设计 §3.2）：ctx.ui.custom() 的组件只在面板打开期间存在；
 * Controller / 树模型 / 导航状态常驻于 extension。关闭面板只是 dispose 视图，
 * 再次打开时用原 Controller 恢复选中节点与 Tab。
 *
 * 宿主 API 约束：custom() 的 done() 关闭 overlay，不假设返回可反复 show/hide 的句柄。
 */


import type { ExplorerController } from "../../src/explorer/controller/explorer-controller.js"
import { mapKey } from "../commands/workflows/navigator/keys.js"
import { renderExplorerBox, type ThemeLike } from "./render.js"

export interface OpenExplorerOptions {
  /** 打开时定位到指定 run（/explorer <runId>） */
  runId?: string
  /** overlay 宽度（缺省 60%；窄终端调 92%） */
  width?: string
}

/** 打开 Explorer overlay；Promise 在用户关闭面板后 resolve */
export async function openExplorer(explorer: ExplorerController, ui: any, options: OpenExplorerOptions = {}): Promise<void> {
  if (options.runId) {
    if (!explorer.selectRun(options.runId)) {
      ui.notify(`未找到 run: ${options.runId}（用 /workflows list 查看可用 run）`, "warning")
      return
    }
  }

  const args = options
  await ui.custom(
    (tui: any, theme: any, _keybindings: unknown, done: () => void) => {
      explorer.open(() => tui.requestRender())
      const themeLike: ThemeLike = {
        fg: (c, s) => (theme?.fg ? theme.fg(c as never, s) : s),
        bg: (c, s) => (theme?.bg ? theme.bg(c as never, s) : s),
        bold: (s) => (theme?.bold ? theme.bold(s) : s),
      }
      const requestRender = () => tui.requestRender()
      const bodyRows = (): number => Math.max(8, Math.floor((tui?.terminal?.rows ?? 24) * 0.9) - 3)

      const component: any = {
        render(width: number): string[] {
          try {
            return renderExplorerBox(explorer.view(), width, bodyRows(), themeLike, {
              // 详情滚动钳制：内容行数只有这里知道（评审修复 M3：End/连续 ↓ 不再越界白屏）
              onDetailMaxScroll: (max) => explorer.noteDetailMaxScroll(max),
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
        dispose(): void {
          // 只释放视图，不销毁状态（再次打开要恢复选中节点）
          explorer.hide()
        },
      }

      /** 原始字节 → 逻辑键 → Controller 导航状态机 */
      const handleKeyData = (data: string): void => {
        const key = mapKey(data)
        if (key === "unknown") return
        // j/k 为 up/down 别名（与 Navigator/watch 一致的手感）
        if (key === "j") return handleKeyData("\x1b[B")
        if (key === "k") return handleKeyData("\x1b[A")
        if (key === "q") {
          done()
          return
        }
        if (key === "o") {
          cycleRun()
          return
        }
        for (const effect of explorer.handleKey(key)) {
          if (effect.kind === "close") {
            done()
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

      return component
    },
    {
      overlay: true,
      // 右侧栏：固定 60% 宽（窄终端内部自动退化为单栏树/详情，renderExplorerFrame 判断）
      overlayOptions: () => ({ width: args.width ?? "60%", maxHeight: "92%", anchor: "right-center", margin: 1 }),
    },
  )
}
