/**
 * 性能基线存储（M5-T2）
 *
 * 按 `workflowId + scriptHash` 聚合多次 run：
 *  - 每类指标保存样本序列（agents / inputTokens / durationMs / failedAgents）
 *  - 计算 P50/P90 与趋势
 *  - **回归检测**：新 run 与历史基线比较，超出容差即判定回归（含误报率记录入口）
 */
import fs from "node:fs"
import path from "node:path"

import { writeFileAtomic } from "../governance/task-registry.js"
import type { EvaluationReport } from "./evaluator.js"

export interface BaselineSample {
  runId: string
  at: number
  inputScale?: string
  agents: number
  inputTokens: number
  outputTokens?: number
  durationMs: number
  failedAgents: number
}

export interface BaselineSeries {
  workflowId: string
  scriptHash: string
  samples: BaselineSample[]
  /** 统计（按全部样本） */
  stats: {
    agents: { p50: number; p90: number; max: number }
    durationMs: { p50: number; p90: number; max: number }
    inputTokens: { p50: number; p90: number; max: number }
    failedAgents: { p50: number; p90: number; max: number }
  }
  updatedAt: number
}

export interface RegressionVerdict {
  regressed: boolean
  /** 触发的指标 */
  signals: Array<{ metric: string; baseline: number; actual: number; threshold: number; ratio: number }>
  /** 是否可判定（样本不足时不可判定，避免假阳性） */
  comparable: boolean
  reason?: string
}

export interface BaselineStoreOptions {
  /** 存储目录（缺省 .pi/workflows/baseline） */
  dir?: string
  cwd?: string
  /** 最少样本数才可做回归判定（缺省 3） */
  minSamples?: number
  /** 回归判定容差（超出 baseline * (1 + tolerance) 视为回归，缺省 0.3） */
  tolerance?: number
}

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!
}

export class BaselineStore {
  private readonly dir: string
  private readonly minSamples: number
  private readonly tolerance: number

  constructor(opts: BaselineStoreOptions = {}) {
    const cwd = opts.cwd ?? process.cwd()
    this.dir = opts.dir ?? path.join(cwd, ".pi", "workflows", "baseline")
    this.minSamples = opts.minSamples ?? 3
    this.tolerance = opts.tolerance ?? 0.3
  }

  private file(workflowId: string, scriptHash: string): string {
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80)
    return path.join(this.dir, `${safe(workflowId)}__${safe(scriptHash.replace(/^sha256:/, "").slice(0, 16))}.json`)
  }

  list(): BaselineSeries[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as BaselineSeries)
    } catch {
      return []
    }
  }

  get(workflowId: string, scriptHash: string): BaselineSeries | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file(workflowId, scriptHash), "utf8")) as BaselineSeries
    } catch {
      return undefined
    }
  }

  /** 追加一次 run 的样本（从 EvaluationReport 转换） */
  record(input: { workflowId: string; scriptHash: string; report: EvaluationReport; outputTokens?: number; at?: number }): BaselineSeries {
    const series = this.get(input.workflowId, input.scriptHash) ?? {
      workflowId: input.workflowId,
      scriptHash: input.scriptHash,
      samples: [],
      stats: {
        agents: { p50: 0, p90: 0, max: 0 },
        durationMs: { p50: 0, p90: 0, max: 0 },
        inputTokens: { p50: 0, p90: 0, max: 0 },
        failedAgents: { p50: 0, p90: 0, max: 0 },
      },
      updatedAt: Date.now(),
    }
    series.samples.push({
      runId: input.report.runId,
      at: input.at ?? Date.now(),
      ...(input.report.inputScale ? { inputScale: input.report.inputScale } : {}),
      agents: input.report.summary.actualAgents,
      inputTokens: input.report.summary.actualInputTokens,
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      durationMs: input.report.summary.durationMs,
      failedAgents: input.report.summary.failedAgents,
    })
    series.stats = this.computeStats(series.samples)
    series.updatedAt = Date.now()
    writeFileAtomic(this.file(input.workflowId, input.scriptHash), JSON.stringify(series, null, 2))
    return series
  }

  private computeStats(samples: BaselineSample[]): BaselineSeries["stats"] {
    const mk = (vals: number[]) => {
      const s = [...vals].sort((a, b) => a - b)
      return { p50: pct(s, 0.5), p90: pct(s, 0.9), max: s.at(-1) ?? 0 }
    }
    return {
      agents: mk(samples.map((x) => x.agents)),
      durationMs: mk(samples.map((x) => x.durationMs)),
      inputTokens: mk(samples.map((x) => x.inputTokens)),
      failedAgents: mk(samples.map((x) => x.failedAgents)),
    }
  }

  /**
   * 回归检测：新 run 是否显著劣于基线。
   * 样本不足 → comparable=false（不判定，避免误报）。
   */
  detectRegression(input: {
    workflowId: string
    scriptHash: string
    actual: { agents: number; durationMs: number; inputTokens: number }
    /** 只与同输入规模样本比较（缺省比较全部） */
    inputScale?: string
  }): RegressionVerdict {
    const series = this.get(input.workflowId, input.scriptHash)
    if (!series) return { regressed: false, signals: [], comparable: false, reason: "无历史基线" }
    const pool = input.inputScale
      ? series.samples.filter((s) => s.inputScale === input.inputScale)
      : series.samples
    if (pool.length < this.minSamples) {
      return {
        regressed: false,
        signals: [],
        comparable: false,
        reason: `样本不足（${pool.length}/${this.minSamples}），不做回归判定`,
      }
    }
    const stats = this.computeStats(pool)
    const signals: RegressionVerdict["signals"] = []
    const cmp = (metric: string, baseline: number, actual: number) => {
      if (baseline <= 0) return
      const ratio = actual / baseline
      if (ratio > 1 + this.tolerance) {
        signals.push({ metric, baseline, actual, threshold: baseline * (1 + this.tolerance), ratio })
      }
    }
    cmp("durationMs", stats.durationMs.p50, input.actual.durationMs)
    cmp("inputTokens", stats.inputTokens.p50, input.actual.inputTokens)
    cmp("agents", stats.agents.p50, input.actual.agents)
    return { regressed: signals.length > 0, signals, comparable: true }
  }

  /** 趋势（最近 N 次的 p50 序列） */
  trend(workflowId: string, scriptHash: string, metric: keyof BaselineSample = "durationMs", lastN = 10): number[] {
    const series = this.get(workflowId, scriptHash)
    if (!series) return []
    return series.samples.slice(-lastN).map((s) => Number(s[metric] ?? 0))
  }
}
