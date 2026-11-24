/**
 * 跨文件聚合分析（2026-11-19 补齐）
 *
 * 问题：真实生产 workflow 是"壳 + 子流程"结构。例如 PrdGameSkill 的
 * `game-requirement-audit.js`（714 行）只是编排壳，真正逻辑在 11 个兄弟子流程里
 * （合计 3513 行）。只分析入口文件会得出"风险 2/100"的假象。
 *
 * 策略（保守、可解释）：
 *  1. **同目录兄弟脚本**：入口所在目录内、源码含 `export const meta` 的 .js 视为子 workflow
 *     （子流程的典型布局；不需要解析 workflow() 的路径变量）
 *  2. **子目录递归**：从源码里提取 `workflow('./x/y.js')` / `'./sub/x.js'` 字面量递归（防环、限深）
 *  3. 聚合口径：`maxRisk` 取最危险单文件（不能相加——会虚高），另给总调用点/总 findings
 */
import fs from "node:fs"
import path from "node:path"

import { buildReport, type AnalysisReport } from "./report-builder.js"

/** 单文件摘要（聚合用，避免把整份 report 塞进父报告） */
export interface SubWorkflowSummary {
  file: string
  riskScore: number
  callSites: number
  dynamicNodes: number
  totalFindings: number
  /** 命中的规则分布（ruleId xN） */
  rules: Record<string, number>
  /** 该文件最严重的 finding 的 ruleId（便于快速判断） */
  topRule?: string
  /**
   * 该文件的 finding 明细（精简字段）。
   * 必要性：入口报告只列入口自己的 findings，若无明细，Dashboard 的「问题列表」里
   * 看不到子流程命中的问题——用户会误以为「规则全通过」。
   */
  findings: Array<{
    ruleId: string
    severity: string
    confidence: number
    startLine: number
    endLine: number
    evidence: string[]
    suggestion?: string
    snippet?: string
  }>
}

export interface TreeAnalysis {
  entry: AnalysisReport
  /** 全部子 workflow（不含入口） */
  subWorkflows: SubWorkflowSummary[]
  /**
   * 参与分析的源码（入口 + 子流程）。
   * AI Rule Checker 需要完整源码做证据校验，但不希望把这些内容塞进 report（会撑大产物）。
   */
  sources: Array<{ file: string; content: string }>
  aggregate: {
    /** 参与分析的文件数（含入口） */
    files: number
    callSites: number
    totalFindings: number
    /** 最危险单文件的风险分（聚合口径：不求和，取最大） */
    maxRisk: number
    /** maxRisk 对应的文件 */
    riskiest?: string
    /** 规则分布（全部文件合并） */
    rules: Record<string, number>
  }
}

export interface TreeAnalysisOptions {
  /** 入口脚本绝对路径 */
  entryPath: string
  /** 最多分析多少文件（防爆；缺省 40） */
  maxFiles?: number
  /** 子目录递归深度（缺省 2） */
  maxDepth?: number
}

/** 是否像 workflow 脚本（含 meta 信封） */
function isWorkflowScript(source: string): boolean {
  return /export\s+const\s+meta\s*=/.test(source)
}

/** 提取源码中指向其他脚本的字符串字面量（workflow('./x.js') 这类） */
export function extractScriptRefs(source: string): string[] {
  const refs = new Set<string>()
  const re = /['"`](\.{1,2}\/[^'"`\n]+\.m?js)['"`]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) refs.add(m[1]!)
  return [...refs]
}

function summarize(report: AnalysisReport, file: string): SubWorkflowSummary {
  const rules: Record<string, number> = {}
  for (const f of report.findings) rules[f.ruleId] = (rules[f.ruleId] ?? 0) + 1
  const top = report.findings[0]
  return {
    file,
    riskScore: report.summary.riskScore,
    callSites: report.executionEstimate.callSites,
    dynamicNodes: report.executionEstimate.dynamicNodes,
    totalFindings: report.summary.totalFindings,
    rules,
    ...(top ? { topRule: top.ruleId } : {}),
    findings: report.findings.map((f) => ({
      ruleId: f.ruleId,
      severity: f.severity,
      confidence: f.confidence,
      startLine: f.location.startLine,
      endLine: f.location.endLine,
      evidence: f.evidence,
      ...(f.suggestion ? { suggestion: f.suggestion } : {}),
      ...(f.snippet ? { snippet: f.snippet } : {}),
    })),
  }
}

/**
 * 分析入口 + 其子 workflow，返回聚合结果。
 *
 * 注意：只做「结构级聚合」（每个文件独立分析后汇总），不做跨文件的变量级数据流分析——
 * 后者需要模块解析与符号表，收益/成本不成比例（见架构基线陷阱 2：不猜测）。
 */
export function analyzeWorkflowTree(opts: TreeAnalysisOptions): TreeAnalysis {
  const entryAbs = path.resolve(opts.entryPath)
  const entryDir = path.dirname(entryAbs)
  const maxFiles = opts.maxFiles ?? 40
  const maxDepth = opts.maxDepth ?? 2

  const entrySource = fs.readFileSync(entryAbs, "utf8")
  const entry = buildReport({ source: entrySource, file: path.basename(entryAbs), generatedAt: "T" })

  const visited = new Set<string>([canonical(entryAbs)])
  const subWorkflows: SubWorkflowSummary[] = []
  const sources: Array<{ file: string; content: string }> = [
    { file: path.basename(entryAbs).split(path.sep).join("/"), content: entrySource },
  ]

  /** 目录内兄弟 workflow（含 meta 的 .js），按文件名排序保证确定性 */
  const collectSiblings = (source: string, dir: string, depth: number): void => {
    if (depth > maxDepth || subWorkflows.length >= maxFiles) return
    // 同目录兄弟
    let names: string[] = []
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".js")).sort()
    } catch {
      return
    }
    for (const name of names) {
      if (subWorkflows.length >= maxFiles) return
      const abs = path.join(dir, name)
      const key = canonical(abs)
      if (visited.has(key)) continue
      let src: string
      try {
        src = fs.readFileSync(abs, "utf8")
      } catch {
        continue
      }
      if (!isWorkflowScript(src)) continue
      visited.add(key)
      // 统一正斜杠：与入口 ref 的书写风格一致，避免同一页面混用 \ 与 /
      const rel = path.relative(path.dirname(entryDir), abs).split(path.sep).join("/")
      const report = buildReport({ source: src, file: rel, generatedAt: "T" })
      subWorkflows.push(summarize(report, rel))
      sources.push({ file: rel, content: src })
      // 该子流程若引用子目录脚本，继续下探
      for (const ref of extractScriptRefs(src)) {
        const refAbs = path.resolve(dir, ref)
        if (!fs.existsSync(refAbs)) continue
        const refDir = path.dirname(refAbs)
        if (canonical(refDir) === canonical(dir)) continue
        collectSiblings(src, refDir, depth + 1)
      }
    }
    void source
  }

  collectSiblings(entrySource, entryDir, 0)

  const rules: Record<string, number> = {}
  for (const f of entry.findings) rules[f.ruleId] = (rules[f.ruleId] ?? 0) + 1
  for (const s of subWorkflows) for (const [k, v] of Object.entries(s.rules)) rules[k] = (rules[k] ?? 0) + v

  const allRisks = [entry.summary.riskScore, ...subWorkflows.map((s) => s.riskScore)]
  const maxRisk = Math.max(...allRisks)
  const riskiestEntry = [{ file: path.basename(entryAbs), risk: entry.summary.riskScore }, ...subWorkflows.map((s) => ({ file: s.file, risk: s.riskScore }))].sort(
    (a, b) => b.risk - a.risk,
  )[0]

  return {
    entry,
    subWorkflows,
    sources,
    aggregate: {
      files: 1 + subWorkflows.length,
      callSites: entry.executionEstimate.callSites + subWorkflows.reduce((a, s) => a + s.callSites, 0),
      totalFindings: entry.summary.totalFindings + subWorkflows.reduce((a, s) => a + s.totalFindings, 0),
      maxRisk,
      ...(riskiestEntry ? { riskiest: riskiestEntry.file } : {}),
      rules,
    },
  }
}

/** Windows 大小写/软链归一（防同文件重复分析） */
function canonical(p: string): string {
  let out = path.resolve(p)
  try {
    out = fs.realpathSync.native(out)
  } catch {
    /* 文件可能不存在 */
  }
  return process.platform === "win32" ? out.toLowerCase() : out
}
