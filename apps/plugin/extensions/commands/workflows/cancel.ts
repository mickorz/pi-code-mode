/**
 * /workflows cancel|stop 子命令：stop 与 cancel 同义。
 * 带 runId 停单个（在飞子会话一并取消），无 runId 停全部在途；
 * journal 均保留，可让模型用 workflow(resumeFromRunId=...) 断点续跑。
 */

import type { Subcommand } from "./types.js"

export const cancelSubcommand: Subcommand = {
  usage: "cancel [runId]              停止某次运行（= stop <runId>）；无 runId 停止全部在途（= stop）",
  async run(argv, ctx, deps) {
    const { runManager } = deps
    if (argv[0]) {
      const ok = await runManager.cancel(argv[0])
      ctx.ui.notify(
        ok
          ? `已停止 ${argv[0]}（在飞子会话一并取消）。已完成部分在 journal 中，可让模型用 workflow(resumeFromRunId="${argv[0]}") 续跑。`
          : `未找到运行中的 run: ${argv[0]}（可能已完成、已停止或不存在）；用 /workflows list 查看。`,
        ok ? "info" : "warning",
      )
      return
    }
    const running = runManager.list().filter((r) => r.status === "running")
    if (!running.length) {
      ctx.ui.notify("当前没有在途运行", "info")
      return
    }
    const results = await Promise.all(running.map((r) => runManager.cancel(r.runId)))
    const stopped = results.filter(Boolean).length
    ctx.ui.notify(`已停止全部在途运行（${stopped}/${running.length}），journal 均保留可续跑`, "info")
  },
}
