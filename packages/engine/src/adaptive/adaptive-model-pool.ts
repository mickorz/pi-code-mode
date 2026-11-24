/**
 * ModelPool 自适应（M4-T4）
 *
 * 信号驱动（不猜测）：
 *  - 429 / rate-limit → 降档（当前模型并发上限减半，或切到低档 tier）
 *  - 超时 / 慢响应 → 降档并发
 *  - 连续成功 → 缓慢回升（不一次跳回，避免抖动）
 *
 * 与既有 model-pool.ts 的关系：本类只管「信号 → 建议」，实际池调度仍由 model-pool 执行。
 */
export type RateSignal = "ok" | "rate_limited" | "timeout" | "error"

export interface ModelSlot {
  /** provider/modelId 或 tier 名 */
  model: string
  /** 基础并发上限（来自配置） */
  baseConcurrency: number
  /** 当前生效并发上限（自适应调整后） */
  effectiveConcurrency: number
  consecutiveOk: number
  consecutiveFail: number
}

export interface AdaptationEvent {
  at: number
  model: string
  signal: RateSignal
  before: number
  after: number
  reason: string
}

export class AdaptiveModelPool {
  private readonly slots: Map<string, ModelSlot> = new Map()
  private readonly events: AdaptationEvent[] = []
  /** 降档系数（每次 signal 失败降低到 1/factor） */
  private readonly degradeFactor: number
  /** 回升步长（连续成功多少次 +1） */
  private readonly recoverAfter: number
  private readonly minConcurrency: number

  constructor(opts: { degradeFactor?: number; recoverAfter?: number; minConcurrency?: number } = {}) {
    this.degradeFactor = opts.degradeFactor ?? 2
    this.recoverAfter = opts.recoverAfter ?? 5
    this.minConcurrency = opts.minConcurrency ?? 1
  }

  register(model: string, concurrency: number): ModelSlot {
    const slot: ModelSlot = {
      model,
      baseConcurrency: Math.max(1, concurrency),
      effectiveConcurrency: Math.max(1, concurrency),
      consecutiveOk: 0,
      consecutiveFail: 0,
    }
    this.slots.set(model, slot)
    return slot
  }

  get(model: string): ModelSlot | undefined {
    return this.slots.get(model)
  }

  list(): ModelSlot[] {
    return [...this.slots.values()]
  }

  /** 记录信号并调整并发上限 */
  record(model: string, signal: RateSignal, now = Date.now()): AdaptationEvent | undefined {
    const slot = this.slots.get(model)
    if (!slot) return undefined
    const before = slot.effectiveConcurrency

    if (signal === "ok") {
      slot.consecutiveOk++
      slot.consecutiveFail = 0
      // 连续成功达到阈值后缓慢回升（不超过基础值）
      if (slot.consecutiveOk >= this.recoverAfter && slot.effectiveConcurrency < slot.baseConcurrency) {
        slot.effectiveConcurrency = Math.min(slot.baseConcurrency, slot.effectiveConcurrency + 1)
        slot.consecutiveOk = 0
        const ev: AdaptationEvent = {
          at: now,
          model,
          signal,
          before,
          after: slot.effectiveConcurrency,
          reason: `连续 ${this.recoverAfter} 次成功，并发回升`,
        }
        this.events.push(ev)
        return ev
      }
      return undefined
    }

    // rate_limited / timeout / error → 降档
    slot.consecutiveFail++
    slot.consecutiveOk = 0
    slot.effectiveConcurrency = Math.max(this.minConcurrency, Math.floor(slot.effectiveConcurrency / this.degradeFactor))
    const reason =
      signal === "rate_limited"
        ? "429/限流信号 → 并发降档"
        : signal === "timeout"
          ? "超时信号 → 并发降档"
          : "错误信号 → 并发降档"
    const ev: AdaptationEvent = { at: now, model, signal, before, after: slot.effectiveConcurrency, reason }
    this.events.push(ev)
    return ev
  }

  /** 从错误对象推断信号（供 adapter 接入） */
  static classifyError(error: unknown): RateSignal {
    const text = String((error as Error)?.message ?? error).toLowerCase()
    if (/429|rate.?limit|too many requests|quota exceeded/.test(text)) return "rate_limited"
    if (/timeout|timed out|etimedout/.test(text)) return "timeout"
    if (/error|fail/.test(text)) return "error"
    return "error"
  }

  /** 当前并发上限（0 = 未知模型，调用方按基础值处理） */
  concurrencyOf(model: string): number | undefined {
    return this.slots.get(model)?.effectiveConcurrency
  }

  history(): AdaptationEvent[] {
    return [...this.events]
  }

  /** 是否处于降档状态 */
  isDegraded(model: string): boolean {
    const slot = this.slots.get(model)
    return Boolean(slot && slot.effectiveConcurrency < slot.baseConcurrency)
  }
}
