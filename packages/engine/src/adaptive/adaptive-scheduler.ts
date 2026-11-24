/**
 * AdaptiveScheduler（M4-T3）
 *
 * 数据来源（P0-1 依赖修正）：**只消费 M2/M3 已有的运行观测数据**
 *  - M2：per-agent usage / 耗时
 *  - M3：TaskCheckpoint 的 durationMs / attempt
 * **不依赖 M5 的正式性能基线**——无历史样本时退化为静态调度（按声明顺序/任务数）。
 *
 * 能力：
 *  1. 轻量耗时画像：按任务类型（阶段/kinds）聚合 P50/P90
 *  2. 波次重排：长任务先发（减少尾部等待）
 *  3. tier 路由建议：按历史耗时给 tier 建议（仅建议，不强制）
 */

export interface DurationSample {
  /** 任务类型键（如 stageId 或任务前缀） */
  taskType: string
  durationMs: number
  /** 可选：耗时来源（live=本次实测 / history=M2/M3 记录） */
  source?: "live" | "history"
}

export interface TaskProfile {
  taskType: string
  samples: number
  p50Ms: number
  p90Ms: number
  maxMs: number
  /** 画像置信度：样本数 < 3 时降低 */
  confidence: number
}

export interface SchedulableTask {
  taskKey: string
  /** 任务类型（用于画像匹配） */
  taskType?: string
  /** 预估耗时（无画像时的静态估计；缺省 0） */
  estimatedMs?: number
}

export interface SchedulingPlan {
  /** 重排后的执行顺序（长任务先发） */
  order: string[]
  /** 每个任务的画像命中情况 */
  matches: Array<{ taskKey: string; taskType: string; estimatedMs: number; from: "profile" | "static" }>
  /** 是否使用了历史画像（false = 纯静态调度） */
  usedProfile: boolean
  notes: string[]
}

/** 从 M2/M3 记录构造画像：按 taskType 聚合 P50/P90 */
export function buildProfiles(samples: readonly DurationSample[]): Map<string, TaskProfile> {
  const byType = new Map<string, number[]>()
  for (const s of samples) {
    if (!Number.isFinite(s.durationMs) || s.durationMs <= 0) continue
    byType.set(s.taskType, [...(byType.get(s.taskType) ?? []), s.durationMs])
  }
  const out = new Map<string, TaskProfile>()
  for (const [taskType, list] of byType) {
    const sorted = [...list].sort((a, b) => a - b)
    const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!
    out.set(taskType, {
      taskType,
      samples: sorted.length,
      p50Ms: pick(0.5),
      p90Ms: pick(0.9),
      maxMs: sorted[sorted.length - 1]!,
      // 样本 <3 时置信度低（不做强建议）
      confidence: Math.min(1, sorted.length / 3),
    })
  }
  return out
}

/** 从 M3 TaskCheckpoint 列表构造样本 */
export function samplesFromCheckpoints(
  tasks: ReadonlyArray<{ taskKey: string; durationMs?: number; updatedAt?: number; committedAt?: number }>,
  typeOf: (taskKey: string) => string = (k) => k.split(/[:/-]/)[0] ?? k,
): DurationSample[] {
  const out: DurationSample[] = []
  for (const t of tasks) {
    const duration = t.durationMs ?? (t.committedAt !== undefined && t.updatedAt !== undefined ? t.updatedAt - t.committedAt : undefined)
    if (duration === undefined || !Number.isFinite(duration) || duration <= 0) continue
    out.push({ taskType: typeOf(t.taskKey), durationMs: duration, source: "history" })
  }
  return out
}

/**
 * 生成调度计划：
 *  - 有画像：按预估耗时降序（长任务先发，压缩尾部等待）
 *  - 无画像：保持输入顺序（静态调度）
 */
export function planSchedule(
  tasks: readonly SchedulableTask[],
  profiles: Map<string, TaskProfile>,
  opts: { typeOf?: (t: SchedulableTask) => string } = {},
): SchedulingPlan {
  const typeOf = opts.typeOf ?? ((t: SchedulableTask) => t.taskType ?? t.taskKey.split(/[:/-]/)[0] ?? t.taskKey)
  const matches: SchedulingPlan["matches"] = []
  const notes: string[] = []
  let profileHits = 0

  for (const t of tasks) {
    const taskType = typeOf(t)
    const prof = profiles.get(taskType)
    if (prof && prof.confidence >= 0.5) {
      profileHits++
      matches.push({ taskKey: t.taskKey, taskType, estimatedMs: prof.p90Ms, from: "profile" })
    } else {
      matches.push({ taskKey: t.taskKey, taskType, estimatedMs: t.estimatedMs ?? 0, from: "static" })
      if (prof) notes.push(`${taskType} 样本不足（${prof.samples} 条），按静态估计`)
    }
  }

  const usedProfile = profileHits > 0
  let order: string[]
  if (usedProfile) {
    // 长任务先发；同耗时保持输入顺序（稳定排序）
    const idx = new Map(tasks.map((t, i) => [t.taskKey, i]))
    order = [...matches]
      .sort((a, b) => b.estimatedMs - a.estimatedMs || (idx.get(a.taskKey)! - idx.get(b.taskKey)!))
      .map((m) => m.taskKey)
    notes.push(`按历史画像重排（${profileHits}/${tasks.length} 任务命中画像，长任务先发）`)
  } else {
    order = tasks.map((t) => t.taskKey)
    notes.push("无可用历史画像 → 静态调度（保持声明顺序）")
  }

  return { order, matches, usedProfile, notes }
}

/** tier 路由建议（仅建议；实际模型选择仍由 Plan/脚本决定） */
export function suggestTier(
  taskType: string,
  profiles: Map<string, TaskProfile>,
  thresholds: { fastMaxMs?: number; bigMinMs?: number } = {},
): { tier: "fast" | "balanced" | "big"; reason: string } {
  const fastMax = thresholds.fastMaxMs ?? 60_000
  const bigMin = thresholds.bigMinMs ?? 600_000
  const prof = profiles.get(taskType)
  if (!prof || prof.confidence < 0.5) return { tier: "balanced", reason: "无足够历史样本（默认 balanced）" }
  if (prof.p90Ms >= bigMin) return { tier: "big", reason: `P90 ${Math.round(prof.p90Ms / 1000)}s ≥ ${Math.round(bigMin / 1000)}s` }
  if (prof.p90Ms <= fastMax) return { tier: "fast", reason: `P90 ${Math.round(prof.p90Ms / 1000)}s ≤ ${Math.round(fastMax / 1000)}s` }
  return { tier: "balanced", reason: `P90 ${Math.round(prof.p90Ms / 1000)}s 介于阈值之间` }
}
