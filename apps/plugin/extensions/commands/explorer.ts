/**
 * /explorer 斜杠命令：打开 / 定位 Workflow Explorer 面板。
 *
 * 与 /workflows ui（Navigator）职责分离（架构设计 §3.3）：
 *   - Navigator：Run 管理入口（启停、注销、Saved 管理）
 *   - Explorer：执行过程观察入口（执行树下钻、节点详情、四 Tab）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { ExplorerController } from "../../../../packages/explorer/src/controller/explorer-controller.js"
import type { WidgetCoordinator } from "../explorer/fixed-panel.js"
import { openExplorer } from "../explorer/index.js"

export interface ExplorerCommandDeps {
  explorer: ExplorerController
  /** widget 互斥协调器（/explorer fixed on|off 切换固定面板与 workflow-tasks） */
  widgets?: WidgetCoordinator
}

export function registerExplorerCommand(pi: ExtensionAPI, deps: ExplorerCommandDeps): void {
  pi.registerCommand("explorer", {
    description:
      "打开 Workflow Explorer（工作流执行观察器）：执行树下钻、节点详情；/explorer <runId> 定位到指定 run；/explorer fixed on|off 切换固定面板（常驻 widget，Ctrl+B overlay 不受影响）",
    getArgumentCompletions: () => null,
    handler: async (args: string, ctx: any) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Workflow Explorer 需要 TUI 交互终端；非交互模式请用 /workflows list 与 /workflows status", "warning")
        return
      }
      const arg = args.trim()
      // fixed 子命令：固定面板开关（写配置 + 立即重挂 widget，互斥 workflow-tasks）
      if (arg.startsWith("fixed")) {
        if (!deps.widgets) {
          ctx.ui.notify("固定面板不可用：widget 协调器未装配", "warning")
          return
        }
        const mode = arg.slice("fixed".length).trim().toLowerCase()
        if (mode === "on" || mode === "off") {
          const config = deps.widgets.setEnabled(ctx, mode === "on")
          ctx.ui.notify(
            `固定面板已${mode === "on" ? "开启（右侧常驻，anchor=" + config.anchor + "，width=" + config.width + "）" : "关闭"}；配置已写入 .pi/workflows/explorer.json`,
            "info",
          )
        } else if (mode === "status" || mode === "") {
          ctx.ui.notify(`固定面板当前${deps.widgets.enabled() ? "已开启" : "已关闭"}；用法：/explorer fixed on|off`, "info")
        } else {
          ctx.ui.notify(`未知参数 "${mode}"；用法：/explorer fixed on|off|status`, "warning")
        }
        return
      }
      const runId = arg || undefined
      await openExplorer(deps.explorer, ctx.ui, { runId })
    },
  })
}
