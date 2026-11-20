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
 *   - workflow-tasks TUI widget（在途 runs 实时摘要，M4）与 Explorer 固定面板 widget 互斥
 *     （/explorer fixed on 切固定面板；默认 off 保持 workflow-tasks，见 explorer/fixed-panel.ts）
 *   - 全局并发闸 + 模型 tier 解析（model-tiers.json -> resolveTier）
 *
 * RunManager 模块级单例：同进程多会话共享，workflow_control 可跨会话查询/取消。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import path from "node:path"
import { RunManager, withGlobalGate } from "../src/manager/run-manager.js"
import { getRuntimeEventBus } from "../src/engine/events/runtime-event-bus.js"
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
import {
  createPlannerAgent,
  createWorkflowAnalyzeTool,
  createWorkflowBenchmarkTool,
  createWorkflowOptimizeTool,
} from "../src/tools/workflow-analyze-tool.js"
import { createPlanValidateTool } from "../src/tools/plan-tool.js"
import { makeScheduleTools } from "../src/tools/schedule-tools.js"
import { createRenderScheduler } from "../src/manager/render-scheduler.js"
import { registerWorkflowsCommand } from "./commands/workflows/index.js"
import { registerScheduleCommand } from "./commands/schedule.js"
import { registerExplorerCommand } from "./commands/explorer.js"
import { toggleExplorer } from "./explorer/index.js"
import { installExplorerStatusLine } from "./explorer/status-line.js"
import {
  createFixedPanel,
  createWidgetCoordinator,
  type WidgetSide,
} from "./explorer/fixed-panel.js"
import { ExplorerController } from "../src/explorer/controller/explorer-controller.js"
import { createRunJournal } from "../src/manager/run-journal.js"

const runManager = new RunManager(16, getRuntimeEventBus())
// run journal 单实例：写入方（workflow 工具 / schedule runner）与读取方（Explorer 详情）共用同一实例，
// 否则读侧会命中陈旧内存缓存（评审修复 H1）
const runJournal = createRunJournal(process.cwd())
// Workflow Explorer 单实例（模块级常驻：Controller/树模型/导航状态与会话同寿，
// Overlay 视图按需创建销毁——关闭面板不丢选中节点）
const explorer = new ExplorerController({
  runManager,
  eventBus: getRuntimeEventBus(),
  cwd: process.cwd(),
  journal: runJournal,
})
// tier 配置引导（可发现性）：工程 .pi/workflows/model-tiers.json 不存在时创建带中文说明的空模板
// （tiers 留空 = 行为与未配置等价，零语义副作用；用户照 __ 说明字段填写即可）。
// 创建结果通过 session_start 的 ui.notify 通知（TUI 吞掉扩展 console.log，工厂期无 ctx.ui 可用）
// 层级设计：工程级为主配置位（随项目走）；全局 ~/.pi/workflows/model-tiers.json 仍可手动创建作机器级兑底
const projectDir = process.cwd()
let tiersTemplateCreated: string | undefined
let tiersTemplateError: string | undefined
try {
  tiersTemplateCreated = ensureModelTiersTemplate(path.join(projectDir, ".pi", "workflows", "model-tiers.json"))
} catch (e) {
  tiersTemplateError = String((e as Error)?.message ?? e)
}
// tier 解析：全局 ~/.pi/workflows/model-tiers.json + 项目级合并（项目同名键覆盖；引擎 agent/model-tiers.ts）
const tiers = loadModelTiers({ projectDir })
// tier 模型池（v2 池化）：数组档位构建进程级池（每模型并发上限，acquire 溢出分配）；
// 字符串档位走 resolveTier 单模型路径（不建池）
const tierPools = new Map<string, ModelPool>()
for (const [tier, entry] of Object.entries(tiers)) {
  if (Array.isArray(entry)) tierPools.set(tier, new ModelPool(entry))
}

function makeDeps(cwd?: string): WorkflowToolDeps {
  return {
    runManager,
    eventBus: getRuntimeEventBus(),
    journal: runJournal,
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
 *  数据源：RunManager.onEvent（lifecycle 微任务即时刷、progress 500ms 节流合并）
 *  非 TUI 模式（print/JSON/RPC 无 UI）ctx.hasUI=false 时 install 由协调器跳过 */
function taskWidgetSide(): WidgetSide {
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

  return {
    install(ctx: any) {
      ctx.ui.setWidget("workflow-tasks", (tui: any, _theme: unknown) => {
        // 事件驱动刷新：lifecycle 事件（started/finished/stopped）微任务即时，progress（attach）500ms 节流合并
        const scheduler = createRenderScheduler(() => tui.requestRender())
        const unsubscribe = runManager.onEvent((e: any) => scheduler.schedule(e.type === "progress" ? "progress" : "lifecycle"))
        return {
          // 宿主 Component 契约要求；本组件按需渲染，无需缓存失效
          invalidate: () => {},
          render,
          dispose: () => {
            unsubscribe()
            scheduler.dispose()
          },
        }
      })
    },
    uninstall(ctx: any) {
      ctx.ui.setWidget("workflow-tasks", undefined)
    },
  }
}

/** 固定面板一侧：右侧 nonCapturing overlay（不抢焦点、常驻、悬浮遮主区右侧） */
function fixedPanelSide(): WidgetSide {
  const panel = createFixedPanel({
    getView: () => explorer.view(),
    hasRunning: () => explorer.hasRunningNodes(),
    cwd: process.cwd(),
  })
  return {
    install: (ctx) => panel.install(ctx),
    uninstall: (ctx) => panel.uninstall(ctx),
  }
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
  // workflow_analyze：M1 Analyzer（静态分析，不执行脚本）
  // M6-P1-3：注入真实 Planner（此前 includeSuggestions 静默失效）
  pi.registerTool(
    createWorkflowAnalyzeTool({
      cwd: process.cwd(),
      plannerAgent: createPlannerAgent({ cwd: process.cwd() }),
    }) as any,
  )
  // plan_validate：M2 Plan 校验（Schema/Profile 边界/指纹/过期）
  pi.registerTool(createPlanValidateTool({ cwd: process.cwd() }) as any)
  // workflow_optimize：M5 优化闭环（默认独立工作区 + 授权闸门，不直接改生产）
  pi.registerTool(createWorkflowOptimizeTool({ cwd: process.cwd(), plannerAgent: createPlannerAgent({ cwd: process.cwd() }) }) as any)
  // workflow_benchmark：M5 真实 before/after 对照——runOnce 复用 workflow 工具真实执行
  const benchmarkWorkflowTool = makeWorkflowTool({ ...makeDeps(), deliver })
  pi.registerTool(
    createWorkflowBenchmarkTool({
      cwd: process.cwd(),
      runOnce: async ({ scriptPath, label, cwd }) => {
        const started = Date.now()
        const out: any = await benchmarkWorkflowTool.execute(
          "bench",
          { scriptPath, background: false },
          undefined,
          undefined,
          {},
        )
        const durationMs = Date.now() - started
        const text: string = out?.content?.[0]?.text ?? ""
        const failed = /失败|failed/i.test(text) && !/\[workflow 完成\]/.test(text)
        return {
          durationMs,
          ok: !failed && !out?.isError,
          ...(failed ? { error: text.slice(0, 200) } : {}),
        }
      },
    }) as any,
  )

  // ---- schedule_* 工具族 ×8 + 调度循环（M4）----
  const scheduleDeps = makeDeps()
  const scheduleRunner = new PiScheduleRunner({
    runManager,
    deliver,
    cwd: process.cwd(),
    eventBus: getRuntimeEventBus(),
    journal: runJournal,
    // M6-P0-3： schedule 复用 workflow 的 tier 解析与模型池（此前静默回退默认模型）
    ...(scheduleDeps.resolveTier ? { resolveTier: scheduleDeps.resolveTier } : {}),
    ...(scheduleDeps.resolveTierPool ? { resolveTierPool: scheduleDeps.resolveTierPool } : {}),
  })
  const scheduler = new ScheduleRuntime({
    client: undefined, // pi 版实现不直调 client（root session 由 PiScheduleRunner 创建）
    directory: process.cwd(),
    manager: scheduleRunner as any,
  })
  scheduler.start()

  for (const tool of makeScheduleTools({ scheduler, cwd: process.cwd() })) {
    pi.registerTool(tool as any)
  }

  // ---- A1: 全局快捷键 ctrl+b 开关 Explorer（免记命令；对齐 opencode 的 keybind 入口）----
  // ctrl+b 在 pi 内置 keybind 中未被占用；再按一次关闭（toggle），不弹提示保持 IDE 手感
  pi.registerShortcut("ctrl+b", {
    description: "打开/关闭 Workflow Explorer（工作流执行观察器）",
    handler: async (ctx: any) => {
      if (!ctx.hasUI) return
      try {
        await toggleExplorer(explorer, ctx.ui)
      } catch (e) {
        // 快捷键回调无宿主编排兜底：异常必须自己兜住，否则打死 TUI
        ctx.ui.notify(`Explorer 打开失败: ${String((e as Error)?.message ?? e)}`, "error")
      }
    },
  })

  // ---- A2: 常驻状态行（在途 run 单行进度；无在途时自动清空）----
  let disposeStatusLine: (() => void) | undefined
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return
    disposeStatusLine?.()
    disposeStatusLine = installExplorerStatusLine(runManager, ctx.ui)
  })
  pi.on("session_shutdown", () => {
    disposeStatusLine?.()
    disposeStatusLine = undefined
  })

  // ---- 斜杠命令（实现见 extensions/commands/，一命令一文件）----
  registerWorkflowsCommand(pi, { runManager, makeDeps, deliver })
  registerScheduleCommand(pi, { scheduler })

  // ---- widget 互斥协调器：固定模式 on → Explorer 常驻面板；off（默认）→ workflow-tasks ----
  const widgets = createWidgetCoordinator({ cwd: process.cwd(), taskWidget: taskWidgetSide(), fixedPanel: fixedPanelSide() })
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return
    widgets.apply(ctx)
  })
  registerExplorerCommand(pi, { explorer, widgets })
}
