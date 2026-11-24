/**
 * Explorer 常驻状态行（A2）：不打开面板也能看到在途 workflow。
 *
 * 形态对齐 opencode 的 session_prompt_right（输入框右侧单行进度），
 * pi 侧落点是 ctx.ui.setStatus(key, text) —— 显示在内置 footer 的状态区。
 *
 * 纯函数 buildStatusText 便于测试；installExplorerStatusLine 负责事件订阅与节流。
 */

import type { RunManager } from "../../../../packages/manager/src/run-manager.js"
import { createRenderScheduler } from "../../../../packages/manager/src/render-scheduler.js"

export const EXPLORER_STATUS_KEY = "workflow"

/** 单行状态文本；无在途 run 时返回 undefined（调用方据此清除状态行） */
export function buildStatusText(
  runManager: RunManager,
  opts: { maxRuns?: number } = {},
): string | undefined {
  const running = runManager.list().filter((r) => r.status === "running")
  if (!running.length) return undefined
  const maxRuns = opts.maxRuns ?? 2
  const parts = running.slice(0, maxRuns).map((r) => {
    const detail = runManager.getSnapshot(r.runId)
    const agents = detail?.agents ?? []
    const done = agents.filter((a) => a.status !== "running").length
    const active = agents.filter((a) => a.status === "running").length
    const name = r.label ?? r.runId
    const progress = agents.length ? ` ${done}/${agents.length}` : ""
    const spinner = active > 0 ? ` · ${active} running` : ""
    return `workflow ${name}${progress}${spinner}`
  })
  const more = running.length > maxRuns ? ` (+${running.length - maxRuns})` : ""
  return `${parts.join("  |  ")}${more}`
}

/**
 * 安装状态行：run 事件驱动刷新（lifecycle 即时 / progress 500ms 节流），
 * 返回卸载函数（session_shutdown 时调用，避免跨会话残留状态）。
 */
export function installExplorerStatusLine(runManager: RunManager, ui: any): () => void {
  if (!ui?.setStatus) return () => {}
  const apply = () => {
    try {
      ui.setStatus(EXPLORER_STATUS_KEY, buildStatusText(runManager))
    } catch (e) {
      // 状态行故障不得击穿宿主（render 类回调无自防御，这里自己兜住）
      console.error("[pi-code-mode] explorer 状态行更新失败:", String((e as Error)?.message ?? e))
    }
  }
  const scheduler = createRenderScheduler(apply)
  const unsubscribe = runManager.onEvent((e) => scheduler.schedule(e.type === "progress" ? "progress" : "lifecycle"))
  apply()
  return () => {
    unsubscribe()
    scheduler.dispose()
    try {
      ui.setStatus(EXPLORER_STATUS_KEY, undefined)
    } catch {
      // 会话已关闭时清理失败可忽略
    }
  }
}
