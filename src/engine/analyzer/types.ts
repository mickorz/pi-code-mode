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
  /** 一句话说明这条规则检查什么（报告里作为"检查项"展示，让用户知道覆盖范围） */
  description: string
  /**
   * true = 该规则**只由 AI Rule Check 判定**，静态 analyze 不产出结论。
   *
   * 为什么需要：有些规则（如 REC-002 跨函数参数传递完整性）需要追踪变量在函数参数、
   * 对象属性间的流动，单文件局部 AST 无法可靠判定；强行写正则近似会产生大量误报。
   * 这类规则静态层声明 aiOnly，报告里状态记 "ai-only" 而不是 "pass"
   * —— 绝不能把"静态没检查"显示成"通过"。
   */
  aiOnly?: boolean
  analyze(context: AnalyzerContext): AnalyzerFinding[]
}
