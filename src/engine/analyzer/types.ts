/**
 * Analyzer 规则注册（M1-T3）
 *
 * 统一接口（架构基线 3.2 规则注册机制）：新增规则不改 Analyzer 主体。
 */
import type { CallGraph, DependencySummary } from "./call-graph.js"
import type { AstAnalysis } from "./ast-parser.js"

export type Severity = "critical" | "high" | "medium" | "low"

export interface AnalyzerContext {
  source: string
  ast: AstAnalysis
  graph: CallGraph
  deps: DependencySummary
  /** concurrency 上限（setConcurrency 静态可确定时；否则 undefined） */
  concurrency?: number
}

export interface AnalyzerFinding {
  ruleId: string
  severity: Severity
  /** 0-1：静态结论置信度（动态/推断类必须降低） */
  confidence: number
  location: { file?: string; startLine: number; endLine: number }
  evidence: string[]
  suggestion?: string
}

export interface AnalyzerRule {
  id: string
  version: string
  severity: Severity
  analyze(context: AnalyzerContext): AnalyzerFinding[]
}
