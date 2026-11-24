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

import { createLimiter, type Limiter } from "../../engine/src/runtime/semaphore.js"
import type {
  AgentRecord,
  CompositeRecord,
  PhaseExecutionRecord,
  ToolExecutionRecord,
  WorkflowExecutionRecord,
} from "../../engine/src/types/index.js"
import type { RuntimeEventBus } from "../../engine/src/events/runtime-event-bus.js"
import type { WorkflowRuntimeEvent } from "../../engine/src/events/workflow-events.js"

export type RunStatus = "running" | "completed" | "failed" | "cancelled"

/** run 事件类型：started=注册、progress=节点高频更新（attach/agent.updated）、
 *  lifecycle=结构性变化（agent 起止、workflow/phaze/composite/tool 起止）、finished=终态、stopped=手动取消 */
export type RunEventType = "started" | "progress" | "lifecycle" | "finished" | "stopped"

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
  /** 以下为 Explorer 观测层（M2 扩展；全部由 attachEvent 增量维护） */
  workflows: WorkflowExecutionRecord[]
  composites: CompositeRecord[]
  tools: ToolExecutionRecord[]
  phases: PhaseExecutionRecord[]
  /** 已接收的最大 Runtime 事件 sequence（0 = 无事件；用于旧事件丢弄） */
  lastSequence: number
  finishedAt?: number
  error?: string
  resultPreview?: string
}

/** 实时快照（Explorer 的唯一数据源；渲染不重放历史事件） */
export type RunSnapshot = Pick<
  ManagedRun,
  "runId" | "status" | "label" | "startedAt" | "finishedAt" | "lastSequence" | "agents" | "workflows" | "composites" | "tools" | "phases"
>

/** 终态 run 的保留上限（防内存无界；只留摘要） */
const RECENT_KEEP = 20

export class RunManager {
  private readonly runs = new Map<string, ManagedRun>()
  private readonly recent: ManagedRun[] = []
  private readonly listeners = new Set<RunListener>()
  /** 全局 Agent 并发闸：wrap(adapter) 后所有 dispatch 过闸排队 */
  readonly gate: Limiter

  constructor(
    maxConcurrent = 16,
    /** 可选事件总线：传入后 run 生命周期的 started/finished 会作为 Runtime 事件下发（M1/M2 接线） */
    private readonly eventBus?: RuntimeEventBus,
  ) {
    this.gate = createLimiter(maxConcurrent)
    // 总线 → 快照的唯一入口（构造期订阅，保证同进程恰好一份订阅；旧事件由 attachEvent 内 sequence 去重）
    this.eventBus?.subscribe((event) => this.attachEvent(event))
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
      workflows: [],
      composites: [],
      tools: [],
      phases: [],
      lastSequence: 0,
    }
    if (options?.externalSignal) {
      if (options.externalSignal.aborted) controller.abort()
      else options.externalSignal.addEventListener("abort", () => controller.abort(), { once: true })
    }
    this.runs.set(runId, run)
    this.emit("started", runId)
    this.eventBus?.publish({ runId, type: "run.started", payload: { label: run.label, startedAt: run.startedAt } })
    return run
  }

  /**
   * Runtime 统一事件入口（M2）：按 sequence 去重 → 更新对应节点 → 更新编号快照 → 通知订阅者。
   *
   * 语义：
   *   - 旧事件（sequence <= lastSequence）直接丢弃，避免晚到事件回退节点状态
   *   - 节点按稳定身份 upsert（不按数组下标，不受并发完成顺序影响）
   *   - 仅 agent.updated 被归为 progress（高频节流）；其余为 lifecycle（即时渲染）
   *   - 未知 run / 已终态 run 的事件静默丢弃（UI 不得反向影响 Runtime）
   */
  attachEvent(event: WorkflowRuntimeEvent): void {
    const run = this.runs.get(event.runId)
    if (!run) return
    if (event.sequence <= run.lastSequence) return
    run.lastSequence = event.sequence
    switch (event.type) {
      case "workflow.started":
      case "workflow.finished":
        upsert(run.workflows, event.payload as WorkflowExecutionRecord, (w) => w.scopePath.join("/"))
        break
      case "phase.started":
      case "phase.finished":
        upsert(run.phases, event.payload as PhaseExecutionRecord, (p) => p.phaseId)
        break
      case "agent.started":
      case "agent.updated":
      case "agent.finished":
        upsert(run.agents, event.payload as AgentRecord, (a) => a.id)
        break
      case "composite.started":
      case "composite.finished":
        upsert(run.composites, event.payload as CompositeRecord, (c) => `${c.scopePath.join("/")}#${c.id}`)
        break
      case "tool.started":
      case "tool.finished":
        upsert(run.tools, event.payload as ToolExecutionRecord, (t) => t.toolId)
        break
      default:
        break
    }
    this.emit(event.type === "agent.updated" ? "progress" : "lifecycle", event.runId)
  }

  /** 实时快照（含全部节点数组的浅拷贝；不存在返回 null） */
  getSnapshot(runId: string): RunSnapshot | null {
    const run = this.status(runId)
    if (!run) return null
    return {
      runId: run.runId,
      status: run.status,
      label: run.label,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      lastSequence: run.lastSequence,
      agents: [...run.agents],
      workflows: [...run.workflows],
      composites: [...run.composites],
      tools: [...run.tools],
      phases: [...run.phases],
    }
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
    this.eventBus?.publish({
      runId,
      type: "run.finished",
      payload: { status: run.status, error: run.error, finishedAt: run.finishedAt },
    })
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

/** 按稳定身份 upsert（同 id 后到者覆盖；不按数组下标，不受完成顺序影响） */
function upsert<T>(list: T[], item: T, identity: (value: T) => string): void {
  const key = identity(item)
  const idx = list.findIndex((v) => identity(v) === key)
  if (idx >= 0) list[idx] = item
  else list.push(item)
}

/** 全局闸包装：所有 Agent dispatch 过 limiter 排队（cancel 等其余方法原样保留） */
export function withGlobalGate<T extends { execute: (request: any, ctx: any) => Promise<any> }>(
  adapter: T,
  gate: Limiter,
): T {
  // 顺序注意：wrapped 在后，其 execute 覆盖 adapter 的同名方法
  return Object.assign({}, adapter, { execute: (request: any, ctx: any) => gate(() => adapter.execute(request, ctx)) }) as T
}
