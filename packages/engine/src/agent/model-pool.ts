/**
 * ModelPool —— 档位模型池：多模型各带并发上限，调度按剩余产能溢出分配（tier 池化 P2）。
 *
 * 需求语义：fast 档 = A×16 + B×8；20 个并发请求 → A 吃满 16、第 17 个起溢出到 B（上限 8），
 * 合计吞吐 = 各模型上限之和，无需显式配比计算。
 *
 * 调度策略：acquire 时选"剩余产能最大"的条目（负载均衡，长跑占用比趋近上限配比）；
 * 全部满载 → FIFO 排队，任一 release 唤醒队首重竞争（公平性：队列顺序优先，不保证绝对公平）。
 * 纯逻辑无 pi SDK 依赖（引擎层约束）；并发语义与 engine/runtime/semaphore.ts 同族但多路复用。
 */

export interface PoolEntryConfig {
  model: string
  /** 该模型的并发上限；缺省视为不限（仅受全局闸约束） */
  concurrency?: number
}

export interface PoolLease {
  model: string
  release(): void
}

interface PoolSlot {
  model: string
  limit: number
  inflight: number
}

export class ModelPool {
  private readonly slots: PoolSlot[]
  /** FIFO 等待队列：全部满载时 acquire 在此挂起，release 唤醒队首 */
  private readonly waiters: Array<() => void> = []

  constructor(entries: PoolEntryConfig[]) {
    const valid = entries.filter((e) => typeof e?.model === "string" && e.model.trim())
    if (!valid.length) throw new Error("ModelPool 至少需要一个有效模型条目")
    this.slots = valid.map((e) => ({
      model: e.model,
      limit: typeof e.concurrency === "number" && e.concurrency > 0 ? e.concurrency : Number.POSITIVE_INFINITY,
      inflight: 0,
    }))
  }

  get models(): string[] {
    return this.slots.map((s) => s.model)
  }

  /** 当前各模型在途数（观测用：测试断言配比） */
  snapshotInflight(): Array<{ model: string; inflight: number; limit: number }> {
    return this.slots.map((s) => ({ model: s.model, inflight: s.inflight, limit: s.limit }))
  }

  private pickFree(): PoolSlot | undefined {
    const free = this.slots.filter((s) => s.inflight < s.limit)
    if (!free.length) return undefined
    // 剩余产能最大者优先（并列取先注册者，天然倾向主模型）
    return free.reduce((best, s) => (s.limit - s.inflight > best.limit - best.inflight ? s : best))
  }

  async acquire(): Promise<PoolLease> {
    // 快路径：有空闲直接取
    const free = this.pickFree()
    if (free) return this.take(free)
    // 慢路径：FIFO 排队，release 唤醒队首重竞争
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    const slot = this.pickFree()
    if (!slot) {
      // 唤醒后仍无空闲（被队首以外的并发竞争抢走）：重新排队
      return this.acquire()
    }
    return this.take(slot)
  }

  private take(slot: PoolSlot): PoolLease {
    slot.inflight++
    let released = false
    return {
      model: slot.model,
      release: () => {
        if (released) return
        released = true
        slot.inflight--
        // 唤醒队首（若在排队）；队首醒来重竞争可能仍选本槽
        const wake = this.waiters.shift()
        wake?.()
      },
    }
  }
}
