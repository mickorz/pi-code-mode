/**
 * RunManager —— 跨 run 注册表 + 全局 Agent 并发闸（R3 P0）
 *
 * 职责：
 *   1. 追踪在途 run（runId -> AbortController/进度/终态），供 workflow_control 的 list/status/cancel
 *   2. 全局 Agent 并发闸（默认 16）：跨 run 兜底，超出排队的 dispatch 在闸前等待
 *      （测试并发上限 ≠ Agent 并发上限：2 个联调 run × run 级 16 = 32 路请求，闸在全局兜底）
 *
 * 单例使用：extension 模块级持有一个实例，同进程多会话共享（跨会话 cancel/status 可达）。
 * 闸的实现复用引擎信号量（engine/runtime/semaphore.ts），零新依赖。
 */

import { createLimiter, type Limiter } from "../engine/runtime/semaphore.js"
import type { AgentRecord } from "../engine/types/index.js"

export type RunStatus = "running" | "completed" | "failed" | "cancelled"

/** run 事件类型：started=注册、progress=节点更新（attach）、finished=终态、stopped=手动取消 */
export type RunEventType = "started" | "progress" | "finished" | "stopped"

export interface RunEvent {
  runId: string
  type: RunEventType
  /** finished 事件携带终态（其余类型省略） */
  status?: RunStatus
}

type RunListener = (event: RunEvent) => void

export interface ManagedRun {
  runId: string
  label?: string
  startedAt: number
  status: RunStatus
  controller: AbortController
  /** onAgentUpdate 收集的节点快照（终态保留供 status 查询） */
  agents: AgentRecord[]
  finishedAt?: number
  error?: string
  resultPreview?: string
}

/** 终态 run 的保留上限（防内存无界；只留摘要） */
const RECENT_KEEP = 20

export class RunManager {
  private readonly runs = new Map<string, ManagedRun>()
  private readonly recent: ManagedRun[] = []
  private readonly listeners = new Set<RunListener>()
  /** 全局 Agent 并发闸：wrap(adapter) 后所有 dispatch 过闸排队 */
  readonly gate: Limiter

  constructor(maxConcurrent = 16) {
    this.gate = createLimiter(maxConcurrent)
  }

  /**
   * 订阅 run 事件（widget/navigator 实时刷新的数据源，替换轮询）；返回退订函数。
   * listener 异常被隔离不击穿 run 流程（事件总线语义；与 widget render 自防御同理）。
   */
  onEvent(listener: RunListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(type: RunEventType, runId: string, status?: RunStatus): void {
    for (const listener of this.listeners) {
      try {
        listener({ runId, type, status })
      } catch (e) {
        // 监听器故障不得阻断编排主流程；根因由监听器自己暴露（console.error 由监听方负责）
        console.error("[pi-code-mode] run 事件监听器异常:", String((e as Error)?.message ?? e))
      }
    }
  }

  /** 注册一个在途 run；externalSignal（如宿主会话中断）aborted 时联动取消 */
  register(runId: string, options?: { label?: string; externalSignal?: AbortSignal }): ManagedRun {
    const controller = new AbortController()
    const run: ManagedRun = {
      runId,
      label: options?.label,
      startedAt: Date.now(),
      status: "running",
      controller,
      agents: [],
    }
    if (options?.externalSignal) {
      if (options.externalSignal.aborted) controller.abort()
      else options.externalSignal.addEventListener("abort", () => controller.abort(), { once: true })
    }
    this.runs.set(runId, run)
    this.emit("started", runId)
    return run
  }

  /** onAgentUpdate 透传：进度快照（供 status 查询） */
  attach(runId: string, record: AgentRecord): void {
    const run = this.runs.get(runId)
    if (!run) return
    const idx = run.agents.findIndex((a) => a.id === record.id)
    if (idx >= 0) run.agents[idx] = record
    else run.agents.push(record)
    this.emit("progress", runId)
  }

  /** run 终态：从在途表移到 recent（保留最近 RECENT_KEEP 条） */
  finish(runId: string, result: { status: Exclude<RunStatus, "running">; error?: string; resultPreview?: string }): void {
    const run = this.runs.get(runId)
    if (!run) return
    run.status = result.status
    run.error = result.error
    run.resultPreview = result.resultPreview
    run.finishedAt = Date.now()
    this.runs.delete(runId)
    this.recent.unshift(run)
    if (this.recent.length > RECENT_KEEP) this.recent.length = RECENT_KEEP
    this.emit("finished", runId, run.status)
  }

  /** 全部 run（在途优先 + 终态 recent）摘要 */
  list(): Array<Pick<ManagedRun, "runId" | "label" | "status" | "startedAt" | "finishedAt" | "error"> & { agents: number }> {
    const all = [...this.runs.values(), ...this.recent]
    return all.map((r) => ({
      runId: r.runId,
      label: r.label,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      error: r.error,
      agents: r.agents.length,
    }))
  }

  /** 单 run 详情（agents 全量快照）；不存在返回 null */
  status(runId: string): ManagedRun | null {
    return this.runs.get(runId) ?? this.recent.find((r) => r.runId === runId) ?? null
  }

  /** 取消在途 run：触发 controller.abort（Engine 侧级联到子会话 abort）；幂等 */
  async cancel(runId: string): Promise<boolean> {
    const run = this.runs.get(runId)
    if (!run) return false
    run.controller.abort()
    this.emit("stopped", runId)
    return true
  }
}

/** 全局闸包装：所有 Agent dispatch 过 limiter 排队（cancel 等其余方法原样保留） */
export function withGlobalGate<T extends { execute: (request: any, ctx: any) => Promise<any> }>(
  adapter: T,
  gate: Limiter,
): T {
  // 顺序注意：wrapped 在后，其 execute 覆盖 adapter 的同名方法
  return Object.assign({}, adapter, { execute: (request: any, ctx: any) => gate(() => adapter.execute(request, ctx)) }) as T
}
