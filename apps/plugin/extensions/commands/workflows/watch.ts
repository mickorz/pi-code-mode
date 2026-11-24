/**
 * /workflows watch 子命令：单 run 专注视图（复刻 pi-dynamic-workflows watchRun 语义）。
 *
 * 关注一次运行：`wf:<runId>` 状态行实时显示进度（RunManager 事件驱动，非轮询），
 * 完成时自动清理状态行并把终态详情渲染进会话（deliver 回传）。
 *
 * 防泄漏三件套（对齐参考实现）：settled 标志一次性收尾、监听器退订、状态行必清理。
 * 同一 runId 幂等（重复 watch 提示已关注）；watchRun 不落全局态——监听器随 run 终态自清理。
 */

import { renderRunStatus } from "../../../../../packages/tools/src/workflow-tools.js"
import type { ManagedRun, RunEvent, RunManager } from "../../../../../packages/manager/src/run-manager.js"
import type { Subcommand } from "./types.js"

/** 状态行单行进度：`标签 [状态] done/total nodes` */
function oneLineProgress(run: ManagedRun): string {
  const done = run.agents.filter((a) => a.status === "ok").length
  return `${run.label ?? run.runId} [${run.status}] ${done}/${run.agents.length} nodes`
}

export interface WatchDeps {
  runManager: RunManager
  /** 宿主状态行（ctx.ui.setStatus 结构化注入，便于测试） */
  setStatus: (key: string, text: string | undefined) => void
  /** 终态详情回传会话（extension 接线 deliver） */
  onFinished?: (text: string) => void
}

export type WatchResult = "ok" | "not-running" | "already-watching"

/** 进程内活跃 watch 表（幂等去重；会话级生命周期，随扩展模块存活） */
const watching = new Set<string>()

/** 清空活跃 watch 表（仅测试辅助：用例间隔离；生产勿调） */
export function resetWatchState(): void {
  watching.clear()
}

/** 核心 watch 逻辑（独立导出供子命令与测试复用） */
export function watchRun(deps: WatchDeps, runId: string): WatchResult {
  const run = deps.runManager.status(runId)
  if (!run || run.status !== "running") return "not-running"
  if (watching.has(runId)) return "already-watching"
  watching.add(runId)

  const key = `wf:${runId}`
  let settled = false
  const update = () => {
    const r = deps.runManager.status(runId)
    if (r && !settled) deps.setStatus(key, oneLineProgress(r))
  }
  const settle = (e: RunEvent) => {
    if (settled) return
    settled = true
    off()
    watching.delete(runId)
    deps.setStatus(key, undefined)
    if (!deps.onFinished) return
    if (e.type === "stopped") {
      deps.onFinished(`[watch] ${runId} 已手动停止（在飞子会话取消，journal 保留可用 resumeFromRunId 续跑）`)
      return
    }
    const r = deps.runManager.status(runId)
    if (r) deps.onFinished(`[watch] run ${runId} ${r.status}\n${renderRunStatus(r)}`)
  }
  const off = deps.runManager.onEvent((e) => {
    if (e.runId !== runId) return
    if (e.type === "progress") update()
    else if (e.type === "finished" || e.type === "stopped") settle(e)
  })
  update()
  return "ok"
}

export const watchSubcommand: Subcommand = {
  usage: "watch <runId>              关注单次运行（状态行实时进度，完成自动清理并回传结果）",
  async run(argv, ctx, deps) {
    if (!argv[0]) {
      ctx.ui.notify("用法: /workflows watch <runId>；全部运行用 /workflows list 查看", "warning")
      return
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("watch 需要 TUI 交互终端（状态行挂在底部状态栏）；非交互模式用 /workflows status 查询", "warning")
      return
    }
    const result = watchRun(
      {
        runManager: deps.runManager,
        setStatus: (key, text) => ctx.ui.setStatus(key, text),
        onFinished: (text) => void deps.deliver(text),
      },
      argv[0],
    )
    if (result === "not-running") {
      ctx.ui.notify(`未找到运行中的 run: ${argv[0]}（可能已完成、已停止或不存在）；用 /workflows list 查看`, "warning")
      return
    }
    if (result === "already-watching") {
      ctx.ui.notify(`该 run 已在关注中: ${argv[0]}（状态行实时刷新，完成自动清理）`, "info")
      return
    }
    ctx.ui.notify(`正在关注 ${argv[0]}（状态行实时刷新；完成后自动清理并回传结果）`, "info")
  },
}
