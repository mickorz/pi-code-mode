/**
 * /workflows 斜杠命令（独立文件，主入口只做装配）
 *
 * 子命令：
 *   /workflows              显示本帮助（无参数默认行为）
 *   /workflows list         列出注册表工作流与最近运行（含全部 runId）
 *   /workflows run <路径|注册表名> [k=v...]  后台执行脚本，结果经 deliver 回传会话
 *   /workflows status <runId>              查看某次运行详情
 *   /workflows cancel <runId>              停止某次运行（= stop <runId>）
 *   /workflows cancel                      停止全部在途运行（= stop）
 *
 * 执行链复用约定：run 分支转发给 workflow 工具同一执行链（脚本解析/校验/journal/RunManager），
 * 命令层固定后台执行——前台会阻塞 TUI 数分钟，后台立返 runId，进度走 widget、结果经 deliver 回传。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { loadRegistry } from "../../src/engine/runtime/workflow-registry.js"
import {
  makeWorkflowTool,
  parseWorkflowsRunArgs,
  renderRunStatus,
  type WorkflowToolDeps,
} from "../../src/tools/workflow-tools.js"
import type { RunManager } from "../../src/manager/run-manager.js"

export interface WorkflowsCommandDeps {
  /** RunManager 模块级单例（与 workflow 工具、widget 共享） */
  runManager: RunManager
  /** 构造 workflow 工具依赖（run 分支复用工具执行链时用） */
  makeDeps: (cwd?: string) => WorkflowToolDeps
  /** 后台 run 结果回传主会话的通道（extension 接线 pi.sendUserMessage） */
  deliver: (text: string) => Promise<void>
}

export function registerWorkflowsCommand(pi: ExtensionAPI, deps: WorkflowsCommandDeps): void {
  const { runManager, makeDeps, deliver } = deps

  pi.registerCommand("workflows", {
    description:
      "workflow 命令入口（无参数显示帮助）；list 列出已注册 workflow 与最近运行；run <路径|名> [k=v...] 后台执行；status <runId> / cancel|stop [runId]（带 id 停单个，无 id 停全部在途）",
    handler: async (args: string, ctx: any) => {
      const cwd = ctx.cwd ?? process.cwd()
      const argv = args.trim().split(/\s+/).filter(Boolean)
      const usage = [
        "workflow 子命令:",
        "  /workflows                             显示本帮助",
        "  /workflows list                        列出注册表工作流与最近运行（含全部 runId）",
        "  /workflows run <路径|注册表名> [k=v...]  后台执行脚本，结果自动回传会话",
        "  /workflows status <runId>              查看某次运行详情",
        "  /workflows cancel <runId>              停止某次运行（= stop <runId>；journal 保留可续跑）",
        "  /workflows cancel                      停止全部在途运行（= stop）",
      ].join("\n")
      if (!argv.length) {
        ctx.ui.notify(usage, "info")
        return
      }
      if (argv[0] === "run") {
        const parsed = parseWorkflowsRunArgs(argv.slice(1))
        if (parsed.error || !parsed.scriptPath) {
          ctx.ui.notify(parsed.error ?? "用法: /workflows run <脚本路径|注册表名> [key=value ...]", "warning")
          return
        }
        const tool = makeWorkflowTool({ ...makeDeps(cwd), deliver })
        const r = await tool.execute("cmd", { scriptPath: parsed.scriptPath, args: parsed.args, background: true }, undefined, undefined, ctx)
        ctx.ui.notify((r as any).content[0].text, "info")
        return
      }
      if (argv[0] === "status") {
        if (!argv[1]) {
          ctx.ui.notify("用法: /workflows status <runId>；全部运行用 /workflows list 查看", "warning")
          return
        }
        ctx.ui.notify(renderRunStatus(runManager.status(argv[1])), "info")
        return
      }
      // cancel 与 stop 同义：带 id 停单个，无 id 停全部在途（journal 保留，可 resumeFromRunId 续跑）
      if (argv[0] === "cancel" || argv[0] === "stop") {
        if (argv[1]) {
          const ok = await runManager.cancel(argv[1])
          ctx.ui.notify(
            ok
              ? `已停止 ${argv[1]}（在飞子会话一并取消）。已完成部分在 journal 中，可让模型用 workflow(resumeFromRunId="${argv[1]}") 续跑。`
              : `未找到运行中的 run: ${argv[1]}（可能已完成、已停止或不存在）；用 /workflows list 查看。`,
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
        return
      }
      if (argv[0] !== "list") {
        ctx.ui.notify(`未知子命令: ${argv[0]}\n${usage}`, "warning")
        return
      }
      const lines: string[] = []
      try {
        const registry = loadRegistry(cwd)
        if (registry.size) {
          lines.push(`已注册工作流（${registry.size}，目录 .pi/workflows/ 或兼容目录）:`)
          for (const [id, wf] of registry) lines.push(`  - ${id}  ${wf.meta?.description ?? ""}`)
        } else {
          lines.push("注册表为空（项目内未发现可注册的 workflow 脚本）")
        }
      } catch (e) {
        lines.push(`注册表读取失败: ${String((e as Error)?.message ?? e)}`)
      }
      const runs = runManager.list()
      lines.push("")
      lines.push(runs.length ? `最近运行（${runs.length}）:` : "最近无 workflow 运行")
      for (const r of runs) {
        lines.push(
          `  - ${r.status.padEnd(9)} ${r.runId}${r.label ? `（${r.label}）` : ""} agents=${r.agents}${r.error ? ` 错误: ${r.error.slice(0, 60)}` : ""}`,
        )
      }
      ctx.ui.notify(lines.join("\n"), "info")
    },
  })
}
