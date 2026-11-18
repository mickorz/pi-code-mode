/**
 * 优化建议质量回评（M5-T3）
 *
 * M1 的 OptimizationSuggestion 带 expectedImpact（无基准时是「待 Benchmark」）。
 * 优化实施前后各跑一次，回评：
 *  - 建议是否有实际效果（是否真的更快/更省）
 *  - 建议可信度评分（命中率）
 *  - 是否损害质量（证据覆盖率/验证通过率）
 *
 * 原则：**不能让建议自己给自己打分**——回评只消费真实测量数据。
 */

export interface SuggestionClaim {
  id: string
  title: string
  /** 声称改善的指标 */
  metric: "durationMs" | "inputTokens" | "outputTokens" | "agents" | "failures"
  /** 声称的方向（应为 improve） */
  claim: string
  /** 质量风险等级（M1 输出） */
  qualityRisk: "low" | "medium" | "high"
}

export interface Measurement {
  /** 优化前 */
  before: Partial<Record<SuggestionClaim["metric"], number>>
  /** 优化后 */
  after: Partial<Record<SuggestionClaim["metric"], number>>
  /** 质量指标（证据覆盖率 0-1 / 验证通过率 0-1） */
  quality?: { evidenceCoverageBefore?: number; evidenceCoverageAfter?: number; validationPassBefore?: number; validationPassAfter?: number }
}

export interface SuggestionVerdict {
  id: string
  title: string
  metric: SuggestionClaim["metric"]
  before?: number
  after?: number
  /** 改善比例（正=变好） */
  improvement?: number
  /** 是否确实改善 */
  effective: boolean
  /** 质量是否受损 */
  qualityDamaged: boolean
  /** 该建议是否可信（有效且未损质量） */
  credible: boolean
  notes: string[]
}

export interface ReviewReport {
  verdicts: SuggestionVerdict[]
  summary: {
    total: number
    effective: number
    qualityDamaged: number
    credible: number
    /** 可信度 = credible / total */
    credibilityScore: number
    /** qualityRisk 预测准确率：标 high/medium 且确实伤质量 / 标 high/medium 总数 */
    riskPredictionAccuracy?: number
  }
}

function improveRatio(metric: SuggestionClaim["metric"], before?: number, after?: number): number | undefined {
  if (before === undefined || after === undefined || before <= 0) return undefined
  // failures/agents/tokens/duration 都是「越小越好」
  return (before - after) / before
}

/**
 * 回评：对比 before/after 实测数据。
 * @param minImprovement 判定为「有效」的最小改善比例（缺省 5%）
 */
export function reviewSuggestions(
  claims: readonly SuggestionClaim[],
  measurements: Record<string, Measurement>,
  opts: { minImprovement?: number } = {},
): ReviewReport {
  const minImprovement = opts.minImprovement ?? 0.05
  const verdicts: SuggestionVerdict[] = []
  let riskHighTotal = 0
  let riskHighCorrect = 0

  for (const claim of claims) {
    const m = measurements[claim.id]
    const notes: string[] = []
    if (!m) {
      verdicts.push({
        id: claim.id,
        title: claim.title,
        metric: claim.metric,
        effective: false,
        qualityDamaged: false,
        credible: false,
        notes: ["无实测数据（优化未执行或未测量）"],
      })
      continue
    }
    const before = m.before[claim.metric]
    const after = m.after[claim.metric]
    const improvement = improveRatio(claim.metric, before, after)
    const effective = improvement !== undefined && improvement >= minImprovement
    if (improvement === undefined) notes.push("before/after 数据缺失，无法判定")

    // 质量检查：证据覆盖率 / 验证通过率不得下降
    let qualityDamaged = false
    const q = m.quality
    if (q?.evidenceCoverageBefore !== undefined && q.evidenceCoverageAfter !== undefined) {
      if (q.evidenceCoverageAfter < q.evidenceCoverageBefore - 1e-9) {
        qualityDamaged = true
        notes.push(`证据覆盖率下降 ${q.evidenceCoverageBefore} → ${q.evidenceCoverageAfter}`)
      }
    }
    if (q?.validationPassBefore !== undefined && q.validationPassAfter !== undefined) {
      if (q.validationPassAfter < q.validationPassBefore - 1e-9) {
        qualityDamaged = true
        notes.push(`验证通过率下降 ${q.validationPassBefore} → ${q.validationPassAfter}`)
      }
    }

    const credible = effective && !qualityDamaged
    if (claim.qualityRisk !== "low") {
      riskHighTotal++
      if (qualityDamaged) riskHighCorrect++
    }
    if (!effective && improvement !== undefined) notes.push(`实际改善 ${(improvement * 100).toFixed(1)}% < 阈值 ${(minImprovement * 100).toFixed(0)}%`)

    verdicts.push({
      id: claim.id,
      title: claim.title,
      metric: claim.metric,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(improvement !== undefined ? { improvement } : {}),
      effective,
      qualityDamaged,
      credible,
      notes,
    })
  }

  const withData = verdicts.filter((v) => v.before !== undefined && v.after !== undefined)
  return {
    verdicts,
    summary: {
      total: verdicts.length,
      effective: verdicts.filter((v) => v.effective).length,
      qualityDamaged: verdicts.filter((v) => v.qualityDamaged).length,
      credible: verdicts.filter((v) => v.credible).length,
      credibilityScore: withData.length === 0 ? 0 : verdicts.filter((v) => v.credible).length / withData.length,
      ...(riskHighTotal > 0 ? { riskPredictionAccuracy: riskHighCorrect / riskHighTotal } : {}),
    },
  }
}

/** 渲染 Markdown */
export function renderReview(report: ReviewReport): string {
  const lines = [`# 优化建议回评`, ""]
  lines.push(`- 建议总数：${report.summary.total}`)
  lines.push(`- 确实改善：${report.summary.effective}`)
  lines.push(`- 损伤质量：${report.summary.qualityDamaged}`)
  lines.push(`- 可信（有效且未损质量）：${report.summary.credible}`)
  lines.push(`- 可信度评分：${(report.summary.credibilityScore * 100).toFixed(1)}%`)
  if (report.summary.riskPredictionAccuracy !== undefined) {
    lines.push(`- 质量风险预测准确率：${(report.summary.riskPredictionAccuracy * 100).toFixed(1)}%`)
  }
  lines.push("", "| 建议 | 指标 | before | after | 改善 | 有效 | 伤质量 | 可信 |")
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |")
  const pct = (v?: number) => (v === undefined ? "—" : `${(v * 100).toFixed(1)}%`)
  for (const v of report.verdicts) {
    lines.push(
      `| ${v.title} | ${v.metric} | ${v.before ?? "—"} | ${v.after ?? "—"} | ${pct(v.improvement)} | ${v.effective ? "是" : "否"} | ${v.qualityDamaged ? "⚠" : ""} | ${v.credible ? "是" : "否"} |`,
    )
  }
  return lines.join("\n")
}
