/**
 * 规则引擎（M1-T3）
 *
 * - 注册式执行：新增规则只需加入 BUILTIN_RULES 或通过 registerRule
 * - 输出确定性：规则顺序固定、finding 排序稳定、相同输入同输出
 * - 严重度归并：critical > high > medium > low
 */
import { analyzeAst } from "./ast-parser.js"
import { analyzeDependencies, buildCallGraph } from "./call-graph.js"
import { BUILTIN_RULES } from "./rules/index.js"
import type { AnalyzerContext, AnalyzerFinding, AnalyzerRule, Severity } from "./types.js"

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 }

export interface RunRulesOptions {
  file?: string
  concurrency?: number
  /** 额外规则（测试/扩展用） */
  extraRules?: AnalyzerRule[]
}

export function buildContext(source: string, opts: RunRulesOptions = {}): AnalyzerContext {
  const ast = analyzeAst(source)
  return {
    source,
    ast,
    graph: buildCallGraph(ast),
    deps: analyzeDependencies(ast, buildCallGraph(ast)),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
  }
}

export function runRules(source: string, opts: RunRulesOptions = {}): { findings: AnalyzerFinding[]; context: AnalyzerContext } {
  const context = buildContext(source, opts)
  const rules = [...BUILTIN_RULES, ...(opts.extraRules ?? [])]
  const findings: AnalyzerFinding[] = []
  for (const rule of rules) {
    try {
      const produced = rule.analyze(context)
      for (const f of produced) {
        findings.push({ ...f, location: { ...f.location, ...(opts.file ? { file: opts.file } : {}) } })
      }
    } catch (e) {
      // 单条规则失败不阻断整体分析（记一条低置信提示）
      findings.push({
        ruleId: rule.id,
        severity: "low",
        confidence: 0,
        location: { startLine: 1, endLine: 1, ...(opts.file ? { file: opts.file } : {}) },
        evidence: [`规则执行失败：${String((e as Error)?.message ?? e)}`],
      })
    }
  }
  // 确定性排序：严重度 → 行号 → ruleId
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.location.startLine - b.location.startLine ||
      a.ruleId.localeCompare(b.ruleId),
  )
  return { findings, context }
}

/** 危险等级（0-100，越高越危险）；仅统计 confidence ≥ 0.5 的 finding */
export function riskScore(findings: AnalyzerFinding[]): number {
  const weight: Record<Severity, number> = { critical: 40, high: 20, medium: 8, low: 2 }
  let score = 0
  for (const f of findings) {
    if (f.confidence < 0.5) continue
    score += weight[f.severity] * f.confidence
  }
  return Math.min(100, Math.round(score))
}
