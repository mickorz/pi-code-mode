/**
 * /workflows status 子命令：查看某次运行详情（节点状态/耗时/错误/结果预览）。
 * 渲染复用 workflow 工具层的 renderRunStatus，与 workflow_control 输出一致。
 */

import { renderRunStatus } from "../../../src/tools/workflow-tools.js"
import type { Subcommand } from "./types.js"

export const statusSubcommand: Subcommand = {
  usage: "status <runId>              查看某次运行详情",
  async run(argv, ctx, deps) {
    if (!argv[0]) {
      ctx.ui.notify("用法: /workflows status <runId>；全部运行用 /workflows list 查看", "warning")
      return
    }
    ctx.ui.notify(renderRunStatus(deps.runManager.status(argv[0])), "info")
  },
}
