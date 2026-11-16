/**
 * 两级渲染调度器（TUI 实时刷新的节流管线，对照 pi-dynamic-workflows workflow-progress 管线思路）：
 *   - lifecycle 类：微任务急行道，同拍去重（run 出现/消失不延迟、不重绘多次）
 *   - progress 类：节流窗口内合并为一次渲染（节点高频更新不打爆渲染循环）
 *
 * 纯调度语义，不感知 widget/render 细节；dispose 清掉挂起的节流定时器（widget dispose 时防泄漏）。
 */

export type RenderScheduleKind = "lifecycle" | "progress"

export function createRenderScheduler(requestRender: () => void, throttleMs = 500) {
  let microQueued = false
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    schedule(kind: RenderScheduleKind): void {
      if (kind === "progress") {
        if (timer) return
        timer = setTimeout(() => {
          timer = undefined
          requestRender()
        }, throttleMs)
        ;(timer as { unref?: () => void }).unref?.()
        return
      }
      if (microQueued) return
      microQueued = true
      queueMicrotask(() => {
        microQueued = false
        requestRender()
      })
    },
    /** 清掉挂起的节流定时器；微任务去重标志无需清理（队列微任务自身幂等） */
    dispose(): void {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
    },
  }
}
