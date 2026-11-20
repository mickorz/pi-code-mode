/**
 * RuntimeEventBus —— 进程内事件分发（不持久化、不反向修改 Runtime 状态）。
 *
 * 语义（对齐架构设计 §4.5）：
 *   - sequence 在 publish 调用点同步分配（每 run 独立递增），因此事件产生顺序即序列顺序
 *   - listener 异常隔离：单个消费端故障不阻断编排主流程、不影响其余消费端
 *   - subscribe 返回退订函数；退订后不再收到事件
 *
 * 纯内存结构，无 TUI / 无 IO 依赖。
 */

import type { WorkflowEventInput, WorkflowRuntimeEvent } from "./workflow-events.js"

type Listener = (event: WorkflowRuntimeEvent) => void

export class RuntimeEventBus {
  private readonly listeners = new Set<Listener>()
  /** runId -> 已分配的最大 sequence（每 run 独立计数） */
  private readonly sequences = new Map<string, number>()

  /** 订阅全部事件；返回退订函数 */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 同步分配 sequence 后广播给全部订阅者 */
  publish(input: WorkflowEventInput): WorkflowRuntimeEvent {
    const sequence = (this.sequences.get(input.runId) ?? 0) + 1
    this.sequences.set(input.runId, sequence)
    const event: WorkflowRuntimeEvent = {
      ...input,
      sequence,
      eventId: `${input.runId}:${sequence}`,
      timestamp: Date.now(),
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (e) {
        // 消费端故障不得阻断编排主流程（根因由消费端自行暴露）
        console.error("[pi-code-mode] runtime 事件监听器异常:", String((e as Error)?.message ?? e))
      }
    }
    return event
  }

  /** 某 run 已分配的最大 sequence（0 = 未产生事件）；消费端断点对齐用 */
  lastSequence(runId: string): number {
    return this.sequences.get(runId) ?? 0
  }

  /** run 终态后释放计数（不影响已下发事件；防长时间进程 map 无界增长） */
  release(runId: string): void {
    this.sequences.delete(runId)
  }

  /** 当前订阅者数量（测试/诊断用） */
  get listenerCount(): number {
    return this.listeners.size
  }
}

/** 全局单例入口（extension 装配期创建一个，同进程共享；测试可直接 new RuntimeEventBus） */
let singleton: RuntimeEventBus | undefined

export function getRuntimeEventBus(): RuntimeEventBus {
  singleton ??= new RuntimeEventBus()
  return singleton
}
