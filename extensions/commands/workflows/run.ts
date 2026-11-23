/**
 * /workflows run 子命令：后台执行脚本。
 *
 * 复用 workflow 工具同一执行链（脚本解析/校验/journal/RunManager）；
 * 固定后台执行——前台会阻塞 TUI 数分钟，后台立返 runId，
 * 进度走 widget、结果经 deliver 回传会话。
 */

import { makeWorkflowTool, parseWorkflowsRunArgs } from "../../../src/tools/workflow-tools.js"
import type { Subcommand } from "./types.js"

export const runSubcommand: Subcommand = {
  usage: "run <路径|注册表名> [<指令文本> | k=v...]  后台执行脚本，结果自动回传会话",
  async run(argv, ctx, deps) {
    const cwd = ctx.cwd ?? process.cwd()
    const parsed = parseWorkflowsRunArgs(argv)
    if (parsed.error || !parsed.scriptPath) {
      ctx.ui.notify(parsed.error ?? "用法: /workflows run <脚本路径|注册表名> <指令文本> 或 ... key=value ...", "warning")
      return
    }
    const tool = makeWorkflowTool({ ...deps.makeDeps(cwd), deliver: deps.deliver })
    const r = await tool.execute("cmd", { scriptPath: parsed.scriptPath, args: parsed.args, background: true }, undefined, undefined, ctx)
    ctx.ui.notify((r as any).content[0].text, "info")
  },
}
