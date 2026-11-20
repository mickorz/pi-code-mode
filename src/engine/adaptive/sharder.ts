/**
 * 输入分片器（M4-T1）
 *
 * 设计原则（架构基线 + 陷阱 5）：
 *  - **确定性**：同输入同分片（排序稳定、边界算法无随机）
 *  - **无遗漏无重复**：分片并集 = 原集合
 *  - **保留边界**：按业务边界（如阶段/条目）切，不按字符硬切破坏结构
 *  - 产出可直接喂给 M3 BatchExecutor 的 BatchTask
 */
import { contentHash } from "../governance/task-fingerprint.js"

export type ShardStrategy = "count" | "bytes" | "boundary"

export interface ShardOptions {
  /** 分片策略：count=按条数，bytes=按估算字节，boundary=按分组边界 */
  strategy?: ShardStrategy
  /** count: 每片条数；bytes: 每片字节上限；boundary: 每片条数上限 */
  limit: number
  /** 用于估算字节的序列化函数（缺省 JSON.stringify） */
  serialize?: (item: unknown) => string
  /** boundary 策略：返回分组键（相同键进同一片，不跨片） */
  boundaryKey?: (item: unknown) => string
  /** 分片键前缀（用于 taskKey 生成） */
  keyPrefix?: string
}

export interface Shard {
  /** 稳定分片键（index 从 0 开始，确定性） */
  key: string
  items: unknown[]
  /** 估算字节（bytes 策略下有意义） */
  estimatedBytes: number
  /** boundary 策略下的分组键 */
  boundary?: string
}

export interface ShardResult {
  shards: Shard[]
  stats: { total: number; shardCount: number; strategy: ShardStrategy; limit: number; deterministic: string }
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

/** 主入口：确定性分片 */
export function shardItems(items: readonly unknown[], opts: ShardOptions): ShardResult {
  const strategy = opts.strategy ?? "count"
  const serialize = opts.serialize ?? ((v: unknown) => JSON.stringify(v) ?? String(v))
  const prefix = opts.keyPrefix ?? "shard"
  const shards: Shard[] = []

  if (strategy === "boundary") {
    if (!opts.boundaryKey) throw new Error("boundary 策略必须提供 boundaryKey")
    // 按 boundaryKey 分组，保持首次出现顺序（确定性）
    const groups = new Map<string, unknown[]>()
    for (const item of items) {
      const k = opts.boundaryKey(item)
      groups.set(k, [...(groups.get(k) ?? []), item])
    }
    let idx = 0
    for (const [key, group] of groups) {
      // 组内超过 limit 时继续切（不丢数据）
      for (let i = 0; i < group.length; i += opts.limit) {
        const slice = group.slice(i, i + opts.limit)
        shards.push({
          key: `${prefix}-${idx++}`,
          items: slice,
          estimatedBytes: slice.reduce<number>((a, it) => a + byteLen(serialize(it)), 0),
          boundary: key,
        })
      }
    }
  } else if (strategy === "bytes") {
    let current: unknown[] = []
    let currentBytes = 0
    for (const item of items) {
      const b = byteLen(serialize(item))
      // 单片超限时独占一片（不丢弃、不拆分单条）
      if (current.length > 0 && currentBytes + b > opts.limit) {
        shards.push({ key: `${prefix}-${shards.length}`, items: current, estimatedBytes: currentBytes })
        current = []
        currentBytes = 0
      }
      current.push(item)
      currentBytes += b
    }
    if (current.length > 0) shards.push({ key: `${prefix}-${shards.length}`, items: current, estimatedBytes: currentBytes })
  } else {
    for (let i = 0; i < items.length; i += opts.limit) {
      const slice = items.slice(i, i + opts.limit)
      shards.push({
        key: `${prefix}-${shards.length}`,
        items: slice,
        estimatedBytes: slice.reduce<number>((a, it) => a + byteLen(serialize(it)), 0),
      })
    }
  }

  const limit = opts.limit
  return {
    shards,
    stats: {
      total: items.length,
      shardCount: shards.length,
      strategy,
      limit,
      // 确定性指纹：同输入同参数 → 同值
      deterministic: contentHash({ strategy, limit, shards: shards.map((s) => ({ key: s.key, n: s.items.length, bytes: s.estimatedBytes })) }),
    },
  }
}

/** 校验：无遗漏无重复（分片并集等于原集合，按引用相等计数） */
export function verifyShards(items: readonly unknown[], result: ShardResult): { ok: boolean; missing: number; duplicated: number; detail: string } {
  const counts = new Map<unknown, number>()
  for (const s of result.shards) for (const it of s.items) counts.set(it, (counts.get(it) ?? 0) + 1)
  let missing = 0
  let duplicated = 0
  const seen = new Set<unknown>()
  for (const it of items) {
    if (!counts.has(it)) missing++
    seen.add(it)
  }
  for (const [it, n] of counts) {
    if (n > 1) duplicated += n - 1
    if (!seen.has(it)) missing++
  }
  return {
    ok: missing === 0 && duplicated === 0,
    missing,
    duplicated,
    detail: `原 ${items.length} 项 → ${result.shards.length} 片，缺失 ${missing}，重复 ${duplicated}`,
  }
}

/**
 * 分片 + 公共上下文提取后的任务构造辅助（与 M3 BatchExecutor 对接）：
 * 返回每个分片的「任务态上下文」——公共部分不重复注入（Shared Context 层引用）。
 */
export interface ShardedTaskPlan<T> {
  /** 公共上下文（Shared Context 层，一次注入，按引用/摘要传递） */
  shared: { ref: string; description?: string }
  /** 每片独有输入（Task Context 层） */
  tasks: Array<{ taskKey: string; shard: Shard; items: T[] }>
  /** 原始证据引用清单（Evidence Reference 层：按需读取，不因摘要丢弃） */
  evidence: Array<{ shardKey: string; ref: string; itemCount: number }>
}

export function planShardedTasks<T>(input: {
  items: readonly T[]
  shard: ShardResult
  sharedRef: string
  sharedDescription?: string
  evidenceRefOf?: (shard: Shard) => string
}): ShardedTaskPlan<T> {
  return {
    shared: { ref: input.sharedRef, ...(input.sharedDescription ? { description: input.sharedDescription } : {}) },
    tasks: input.shard.shards.map((s) => ({ taskKey: s.key, shard: s, items: s.items as T[] })),
    evidence: input.shard.shards.map((s) => ({
      shardKey: s.key,
      ref: input.evidenceRefOf ? input.evidenceRefOf(s) : `${input.sharedRef}#${s.key}`,
      itemCount: s.items.length,
    })),
  }
}
