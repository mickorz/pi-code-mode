/**
 * /workflows ui 子命令：Navigator 全屏交互面板（完整复刻 pi-dynamic-workflows openWorkflowNavigator）。
 *
 * 宿主通道：ctx.ui.custom(factory, { overlay: true, overlayOptions })——带键盘焦点的 overlay 组件，
 * done(result) 关闭并 resolve。数据源：RunManager 事件出口（实时刷新）+ loadRegistry（注册表）。
 * 操作映射（与参考项目差异已按本仓库语义裁剪）：x=停止运行（confirm）、u=注销工作流（confirm）、
 * rename/save/pause 等参考项目专属能力不适用（见 dev-docs/research 对比文档 §3）。
 */

import type { Component } from "@earendil-works/pi-tui"
import { loadRegistry, removeFromManifest } from "../../../../../../packages/engine/src/runtime/workflow-registry.js"
import type { RunManager } from "../../../../../../packages/manager/src/run-manager.js"
import type { NavigatorRunRow, NavigatorSavedRow } from "./model.js"
import { NavigatorModel } from "./model.js"
import { renderOverlayBox, type ThemeLike } from "./render.js"
import { mapKey } from "./keys.js"
import type { Subcommand } from "../types.js"

export const uiSubcommand: Subcommand = {
  usage: "ui                         打开 Navigator 全屏交互面板（浏览/过滤/停止/注销）",
  async run(_argv, ctx, deps) {
    if (!ctx.hasUI) {
      ctx.ui.notify("Navigator 需要 TUI 交互终端；非交互模式请用 /workflows list 与 /workflows status", "warning")
      return
    }
    await openNavigator(deps.runManager, ctx.cwd ?? process.cwd(), ctx.ui)
  },
}

/** 打开 overlay（独立导出供测试与未来其它入口复用）；Promise 在用户关闭面板后 resolve */
export async function openNavigator(runManager: RunManager, cwd: string, ui: any): Promise<void> {
  const model = new NavigatorModel()

  const buildRuns = (): NavigatorRunRow[] =>
    runManager.list().map((r) => {
      const detail = runManager.status(r.runId)
      return {
        runId: r.runId,
        label: r.label,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        error: r.error,
        agents: (detail?.agents ?? []).map((a) => ({
          id: a.id,
          label: a.label,
          status: a.status,
          phase: a.phase,
          durationMs: a.durationMs,
          tokens: a.tokens,
          replayed: a.replayed,
        })),
      }
    })

  const buildSaved = (): NavigatorSavedRow[] =>
    Array.from(loadRegistry(cwd).values()).map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      file: w.filePath,
    }))

  await ui.custom(
    // 宿主签名：(tui, theme, keybindings, done) => Component；本面板只用 tui/theme/done
    (tui: any, theme: any, _keybindings: unknown, done: () => void) => {
      const requestRender = () => tui.requestRender()
      // RunManager 事件出口（widget 事件驱动化落地的基础设施）驱动面板实时刷新
      const unsubscribe = runManager.onEvent(() => requestRender())
      // 主题结构化适配：宿主 theme 缺任一方法时退化为无色文本，不击穿渲染
      const themeLike: ThemeLike = {
        fg: (c, s) => (theme?.fg ? theme.fg(c as never, s) : s),
        bg: (c, s) => (theme?.bg ? theme.bg(c as never, s) : s),
        bold: (s) => (theme?.bold ? theme.bold(s) : s),
      }
      const bodyRows = (): number => Math.max(6, Math.floor((tui?.terminal?.rows ?? 24) * 0.92) - 4)

      const component: Component & { dispose(): void } = {
        /** 宿主 Component 契约要求；本组件按需渲染，无需缓存失效 */
        invalidate(): void {},
        render(width: number): string[] {
          try {
            model.setData(buildRuns(), buildSaved())
            // snapshot 需要视口行数（滚动钳制用）；漏传会让钳制算出 NaN
            return renderOverlayBox(model.snapshot(bodyRows()), width, bodyRows(), themeLike)
          } catch (e) {
            // 渲染自防御（同 widget render 教训：异常击穿宿主进程），根因打日志暴露
            console.error("[pi-code-mode] navigator render 失败:", String((e as Error)?.message ?? e))
            return [`[navigator render 失败] ${String((e as Error)?.message ?? e)}`]
          }
        },
        handleInput(data: string): void {
          const key = mapKey(data)
          if (key === "unknown") return
          for (const effect of model.act(key)) {
            if (effect.kind === "close") {
              done()
            } else if (effect.kind === "exec-stop") {
              void runManager
                .cancel(effect.runId)
                .then((ok) => ui.notify(ok ? `已停止 ${effect.runId}（journal 保留可续跑）` : `无法停止 ${effect.runId}（可能已结束）`, ok ? "info" : "warning"))
                .catch((e) => ui.notify(`停止失败: ${String((e as Error)?.message ?? e)}`, "error"))
            } else if (effect.kind === "exec-unregister") {
              try {
                const removed = removeFromManifest(cwd, effect.id)
                ui.notify(
                  removed ? `已注销 workflow "${effect.id}"（脚本原位保留）` : `未找到 workflow "${effect.id}"`,
                  removed ? "info" : "warning",
                )
              } catch (e) {
                ui.notify(`注销失败: ${String((e as Error)?.message ?? e)}`, "error")
              }
            }
          }
          requestRender()
        },
        dispose(): void {
          unsubscribe()
        },
      }
      return component
    },
    {
      overlay: true,
      overlayOptions: () => ({ width: "94%", maxHeight: "92%", anchor: "center", margin: 1 }),
    },
  )
}
