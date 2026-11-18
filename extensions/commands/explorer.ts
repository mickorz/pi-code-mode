/**
 * /explorer 斜杠命令：打开 / 定位 Workflow Explorer 面板。
 *
 * 与 /workflows ui（Navigator）职责分离（架构设计 §3.3）：
 *   - Navigator：Run 管理入口（启停、注销、Saved 管理）
 *   - Explorer：执行过程观察入口（执行树下钻、节点详情、四 Tab）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { ExplorerController } from "../../src/explorer/controller/explorer-controller.js"
import { openExplorer } from "../explorer/index.js"

export interface ExplorerCommandDeps {
  explorer: ExplorerController
}

export function registerExplorerCommand(pi: ExtensionAPI, deps: ExplorerCommandDeps): void {
  pi.registerCommand("explorer", {
    description:
      "打开 Workflow Explorer（工作流执行观察器）：执行树下钻、节点详情、Workflow/Agents/Tools/Journal 四 Tab；/explorer <runId> 直接定位到指定 run",
    getArgumentCompletions: () => null,
    handler: async (args: string, ctx: any) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Workflow Explorer 需要 TUI 交互终端；非交互模式请用 /workflows list 与 /workflows status", "warning")
        return
      }
      const runId = args.trim() || undefined
      await openExplorer(deps.explorer, ctx.ui, { runId })
    },
  })
}
