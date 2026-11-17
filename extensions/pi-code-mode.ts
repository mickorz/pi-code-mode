/**
 * pi-code-mode extension 入口（pi package manifest 指向本文件）
 *
 * 职责：装配——单例与依赖创建、工具注册、调度循环启动，然后逐个挂命令与 widget。
 * 斜杠命令实现放 extensions/commands/（一命令一文件/一目录）：
 *   - commands/workflows/    /workflows（index 路由 + run/list/status/cancel 子命令文件）
 *   - commands/schedule.ts   /schedule
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
import { ModelPool } from "../src/engine/agent/model-pool.js"
import { ensureModelTiersTemplate } from "../src/engine/agent/model-tiers.js"
import { PiScheduleRunner } from "../src/manager/pi-schedule-runner.js"
import { ScheduleRuntime } from "../src/engine/schedule/runtime.js"
import { loadModelTiers } from "../src/engine/agent/model-tiers.js"
import { PiAgentAdapter } from "../src/adapter/pi-agent-adapter.js"
import {
  makeWorkflowTool,
  makeWorkflowControlTool,
  type WorkflowToolDeps,
} from "../src/tools/workflow-tools.js"
import { makeScheduleTools } from "../src/tools/schedule-tools.js"
import { createRenderScheduler } from "../src/manager/render-scheduler.js"
import { registerWorkflowsCommand } from "./commands/workflows/index.js"
import { registerScheduleCommand } from "./commands/schedule.js"

const runManager = new RunManager(16)
// tier 配置引导（可发现性）：全局 model-tiers.json 不存在时创建带中文说明的空模板
// （tiers 留空 = 行为与未配置等价，零语义副作用；用户照 __ 说明字段填写即可）。
// 创建结果通过 session_start 的 ui.notify 通知（TUI 吞掉扩展 console.log，工厂期无 ctx.ui 可用）
let tiersTemplateCreated: string | undefined
let tiersTemplateError: string | undefined
try {
  tiersTemplateCreated = ensureModelTiersTemplate()
} catch (e) {
  tiersTemplateError = String((e as Error)?.message ?? e)
}
// tier 解析：~/.pi/workflows/model-tiers.json + 项目级合并（引擎 agent/model-tiers.ts）
const tiers = loadModelTiers()
// tier 模型池（v2 池化）：数组档位构建进程级池（每模型并发上限，acquire 溢出分配）；
// 字符串档位走 resolveTier 单模型路径（不建池）
const tierPools = new Map<string, ModelPool>()
for (const [tier, entry] of Object.entries(tiers)) {
  if (Array.isArray(entry)) tierPools.set(tier, new ModelPool(entry))
}

function makeDeps(cwd?: string): WorkflowToolDeps {
  return {
    runManager,
    adapterFactory: () => withGlobalGate(new PiAgentAdapter({ defaultCwd: cwd ?? process.cwd() }), runManager.gate),
    cwd,
    // 模型分层解析（R3 P2）：tier 名 -> provider/modelId（未配置的 tier 回退会话默认模型）；
    // 数组档位回退首模型（池缺失环境如 print 模式直调时的兼容面，正常链路走 resolveTierPool）
    resolveTier: (tier: string) => {
      const e = tiers[tier]
      return typeof e === "string" ? e : Array.isArray(e) ? e[0]?.model : undefined
    },
    // 模型池解析（v2）：池内每模型并发上限 + 溢出分配（20 并发 = A16+B8 共用）
    resolveTierPool: (tier: string) => tierPools.get(tier),
  }
}

/** workflow-tasks widget：在途 runs 实时摘要（事件驱动，idle 零开销）
 *  数据源：RunManager.onEvent（lifecycle 微任务即时刷、progress 500ms 节流合并，替换原 2s 轮询）
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
      // 事件驱动刷新：lifecycle 事件（started/finished/stopped）微任务即时，progress（attach）500ms 节流合并
      const scheduler = createRenderScheduler(() => tui.requestRender())
      const unsubscribe = runManager.onEvent((e) => scheduler.schedule(e.type === "progress" ? "progress" : "lifecycle"))
      return {
        render,
        dispose: () => {
          unsubscribe()
          scheduler.dispose()
        },
      }
    })
  })
}

export default function extension(pi: ExtensionAPI): void {
  // tier 模板创建结果通知（TUI 可见通道；工厂期无 ctx.ui，延迟到 session_start）
  pi.on("session_start", (_event, ctx) => {
    if (tiersTemplateCreated) {
      const msg = `已创建 tier 配置模板: ${tiersTemplateCreated}（tiers 为空，不改变默认行为；照文件内说明填写后生效）`
      if (ctx.hasUI) ctx.ui.notify(msg, "info")
      else console.log(`[pi-code-mode] ${msg}`)
      tiersTemplateCreated = undefined
    }
    if (tiersTemplateError) {
      const msg = `tier 配置模板创建失败: ${tiersTemplateError}`
      if (ctx.hasUI) ctx.ui.notify(msg, "warning")
      else console.error(`[pi-code-mode] ${msg}`)
      tiersTemplateError = undefined
    }
  })

  // 后台 run / schedule run / watch 终态完成回传主会话（M3 结果回传通道：pi.sendUserMessage）
  const deliver = async (text: string) => {
    try {
      // Agent 回合处理中时排队为 followUp：默认直接投递会在回合中抛错导致回传丢失
      // （2026-11-16 实测：watch 终态与 workflow 完成回传竞争时丢 [workflow 完成] 块）
      await pi.sendUserMessage(text, { deliverAs: "followUp" })
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

  // ---- 斜杠命令（实现见 extensions/commands/，一命令一文件）----
  registerWorkflowsCommand(pi, { runManager, makeDeps, deliver })
  registerScheduleCommand(pi, { scheduler })

  // workflow-tasks widget（M4）：在途 runs 实时摘要
  installTaskWidget(pi)
}
