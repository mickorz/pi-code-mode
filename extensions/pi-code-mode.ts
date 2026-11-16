/**
 * pi-code-mode extension 入口（pi package manifest 指向本文件）
 *
 * 注册面（M1-M4 全量）：
 *   - workflow / workflow_control 工具（编排执行与控制）
 *   - schedule_* 工具族 ×8 + ScheduleRuntime 调度循环（M4）
 *   - /workflows、/schedule 斜杠命令
 *   - workflow-tasks TUI widget（在途 runs 实时摘要，M4）
 *   - 全局并发闸 + 模型 tier 解析（model-tiers.json -> resolveTier）
 *
 * RunManager 模块级单例：同进程多会话共享，workflow_control 可跨会话查询/取消。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { RunManager, withGlobalGate } from "../src/manager/run-manager.js"
import { PiScheduleRunner } from "../src/manager/pi-schedule-runner.js"
import { ScheduleRuntime } from "../src/engine/schedule/runtime.js"
import { loadModelTiers } from "../src/engine/agent/model-tiers.js"
import { PiAgentAdapter } from "../src/adapter/pi-agent-adapter.js"
import { loadRegistry } from "../src/engine/runtime/workflow-registry.js"
import { makeWorkflowTool, makeWorkflowControlTool, parseWorkflowsRunArgs, renderRunStatus, type WorkflowToolDeps } from "../src/tools/workflow-tools.js"
import { makeScheduleTools } from "../src/tools/schedule-tools.js"

const runManager = new RunManager(16)
// tier 解析：~/.pi/workflows/model-tiers.json + 项目级合并（引擎 agent/model-tiers.ts）
const tiers = loadModelTiers()

function makeDeps(cwd?: string): WorkflowToolDeps {
  return {
    runManager,
    adapterFactory: () => withGlobalGate(new PiAgentAdapter({ defaultCwd: cwd ?? process.cwd() }), runManager.gate),
    cwd,
    // 模型分层解析（R3 P2）：tier 名 -> provider/modelId（未配置的 tier 回退会话默认模型）
    resolveTier: (tier: string) => tiers[tier],
  }
}

/** workflow-tasks widget：在途 runs 实时摘要（2s 节流刷新，idle 零开销）
 *  宿主 API：widget 挂在 ctx.ui（session_start 事件上下文），工厂期不可直接调用；
 *  非 TUI 模式（print/JSON/RPC 无 UI）ctx.hasUI=false 跳过注册 */
function installTaskWidget(pi: ExtensionAPI): void {
  // render 运行在宿主 TUI 渲染循环内，任何异常都会击穿宿主进程（2026-11-15 实测：
  // 曾因 list() 快照的 agents 是 number 而非数组，r.agents.filter 抛 TypeError 直接
  // 杀死整个 pi 宿主）——因此整个 render 必须自防御，异常时返回空行集。
  const render = (width: number): string[] => {
    try {
      const running = runManager.list().filter((r) => r.status === "running")
      if (!running.length) return []
      const lines = [`workflow 进行中（${running.length}）:`]
      for (const r of running) {
        // list() 快照的 agents 是数量（number）；done 进度走 status() 全量快照
        const detail = runManager.status(r.runId)
        const agents = detail?.agents ?? []
        const done = agents.filter((a) => a.status === "ok").length
        lines.push(`  ${r.label ?? r.runId}  ${done}/${agents.length} nodes`)
      }
      // 截断超宽行（终端列宽约束）
      return lines.map((l) => (l.length > width ? l.slice(0, Math.max(0, width - 1)) : l))
    } catch (e) {
      console.error("[pi-code-mode] widget render 失败:", String((e as Error)?.message ?? e))
      return []
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return
    ctx.ui.setWidget("workflow-tasks", (tui: any, _theme: unknown) => {
      const timer = setInterval(() => tui.requestRender(), 2000)
      ;(timer as { unref?: () => void }).unref?.()
      return {
        render,
        dispose: () => clearInterval(timer),
      }
    })
  })
}

export default function extension(pi: ExtensionAPI): void {
  // 后台 run / schedule run 完成回传主会话（M3 结果回传通道：pi.sendUserMessage）
  const deliver = async (text: string) => {
    try {
      await pi.sendUserMessage(text)
    } catch (e) {
      // 会话已关闭等场景：后台 run 仍继续（对齐 opencode 版"不 kill"语义），回传失败静默
      console.error("[pi-code-mode] 后台结果回传失败:", String((e as Error)?.message ?? e))
    }
  }

  pi.registerTool(makeWorkflowTool({ ...makeDeps(), deliver }) as any)
  pi.registerTool(makeWorkflowControlTool(makeDeps()) as any)

  // ---- schedule_* 工具族 ×8 + 调度循环（M4）----
  const scheduleRunner = new PiScheduleRunner({ runManager, deliver, cwd: process.cwd() })
  const scheduler = new ScheduleRuntime({
    client: undefined, // pi 版实现不直调 client（root session 由 PiScheduleRunner 创建）
    directory: process.cwd(),
    manager: scheduleRunner as any,
  })
  scheduler.start()

  for (const tool of makeScheduleTools({ scheduler, cwd: process.cwd() })) {
    pi.registerTool(tool as any)
  }

  // /schedule：查看定时任务列表与用法（创建/修改走 schedule_* 工具自然对话）
  pi.registerCommand("schedule", {
    description: "查看定时任务列表与 schedule_create 用法",
    handler: async (_name: string, ctx: any) => {
      const cwd = ctx.cwd ?? process.cwd()
      const lines: string[] = []
      try {
        for (const tool of makeScheduleTools({ scheduler, cwd })) {
          if (tool.name === "schedule_list") {
            const r = await (tool as any).execute("cmd", {}, undefined, undefined, { cwd })
            lines.push(r.content[0].text)
          }
        }
      } catch (e) {
        lines.push(`读取失败: ${String((e as Error)?.message ?? e)}`)
      }
      lines.push("")
      lines.push("创建定时任务：对话中描述需求（如「每天 9 点跑 daily-review」），由 schedule_create 落配置；")
      lines.push("边界：pi 运行期间生效，关闭不执行、错过不补跑；checkpoint 在无人值守执行中视为失败。")
      ctx.ui.notify(lines.join("\n"), "info")
    },
  })

  // /workflows：无参数显示帮助；list 列出注册表工作流与最近运行（M2）；
  // run/status/cancel|stop 子命令：后台执行、查详情、停单个/全部在途
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
        // 复用 workflow 工具同一执行链（脚本解析/校验/journal/RunManager）；
        // 命令层固定后台执行：前台会阻塞 TUI 数分钟，后台立返 runId，进度走 widget、结果经 deliver 回传
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

  // workflow-tasks widget（M4）：在途 runs 实时摘要
  installTaskWidget(pi)
}
