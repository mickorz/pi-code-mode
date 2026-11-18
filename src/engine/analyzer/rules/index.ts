/**
 * 内置规则集（M1-T3）
 *
 * 规则 ID 命名：<领域>-<序号>
 *  CONC  并发/波次   INPUT 输入规模与重复注入   SERIAL 串行/并行候选
 *  TIMEOUT 超时      RETRY 重试成本            DET 确定性可代码化    REC 恢复能力
 *
 * 原则（陷阱 2）：静态结论必须带 confidence；Candidate/Unknown 不得升级为确定缺陷。
 */
import type { AnalyzerContext, AnalyzerFinding, AnalyzerRule } from "../types.js"

/** 从源码静态提取 setConcurrency(n) 与 agent 数 */
function staticsOf(ctx: AnalyzerContext) {
  const m = /setConcurrency\s*\(\s*(\d+)\s*\)/.exec(ctx.source)
  const concurrency = m ? Number(m[1]) : ctx.concurrency
  const agentCalls = ctx.graph.counts.agent ?? 0
  const workflows = ctx.graph.counts.workflow ?? 0
  return { concurrency, agentCalls, workflows, total: agentCalls + workflows }
}

/** CONC-001：并行波次估算（任务数 > 并发上限） */
export const concWaves: AnalyzerRule = {
  id: "CONC-001",
  version: "1.0",
  severity: "medium",
  analyze(ctx) {
    const { concurrency, total } = staticsOf(ctx)
    const parallelNodes = ctx.ast.nodes.filter((n) => n.kind === "parallel" || n.kind === "pipeline")
    if (parallelNodes.length === 0) return []
    const findings: AnalyzerFinding[] = []
    // 静态可确定的并行任务数：parallel 内部的 agent 调用点 × 可确定循环上界
    let estTasks = 0
    let determined = true
    for (const node of ctx.ast.nodes.filter((n) => n.containerId && (n.kind === "agent" || n.kind === "workflow"))) {
      const bound = node.loopBounds?.max
      if (bound !== undefined) estTasks += bound
      else if (!node.dynamic) estTasks += 1
      else determined = false
    }
    if (estTasks === 0) return []
    const cap = concurrency ?? 16
    if (estTasks > cap) {
      const waves = Math.ceil(estTasks / cap)
      findings.push({
        ruleId: "CONC-001",
        severity: "medium",
        confidence: determined ? 0.9 : 0.5,
        location: { startLine: parallelNodes[0]!.startLine, endLine: parallelNodes[0]!.endLine },
        evidence: [
          `并行调用点约 ${estTasks} 个${determined ? "" : "（含动态节点，估算下限）"}`,
          `并发上限 ${cap}`,
          `预计 ${waves} 个波次`,
        ],
        suggestion: "评估分片合并或减少任务数；波次越多，长尾 Agent 对墙钟影响越显著",
      })
    }
    return findings
  },
}

/** INPUT-001：重复上下文注入（同一大对象被多次传递） */
export const inputRepeat: AnalyzerRule = {
  id: "INPUT-001",
  version: "1.0",
  severity: "high",
  analyze(ctx) {
    const findings: AnalyzerFinding[] = []
    // 统计每个标识符在多少个 agent/workflow 调用参数中出现（含动态模板引用）
    const usage = new Map<string, number[]>()
    for (const n of ctx.ast.nodes) {
      if (n.kind !== "agent" && n.kind !== "workflow") continue
      for (const id of n.referencedIdentifiers) {
        if (id.length < 3) continue
        usage.set(id, [...(usage.get(id) ?? []), n.startLine])
      }
    }
    for (const [ident, lines] of usage) {
      if (lines.length < 2) continue
      // JSON.stringify(x) 或 x 直接出现都计入；只看出现≥2 次的公共标识符
      const serialized = new RegExp(`JSON\\.stringify\\s*\\(\\s*${ident}\\b`).test(ctx.source)
      findings.push({
        ruleId: "INPUT-001",
        severity: serialized && lines.length >= 3 ? "high" : "medium",
        confidence: serialized ? 0.85 : 0.6,
        location: { startLine: Math.min(...lines), endLine: Math.max(...lines) },
        evidence: [
          `标识符 \`${ident}\` 在 ${lines.length} 个 agent/workflow 调用中出现（行 ${lines.join(", ")}）`,
          ...(serialized ? [`并以 JSON.stringify 方式整体注入（序列化开销 × ${lines.length}）`] : []),
        ],
        suggestion:
          "提取为 Shared Context 公共引用（M4 三层上下文），保留 Evidence Reference 层的原始来源；不要压缩成摘要代替原文",
      })
    }
    return findings
  },
}

/** SERIAL-001：串行链（仅提示，不判定为缺陷） */
export const serialChain: AnalyzerRule = {
  id: "SERIAL-001",
  version: "1.0",
  severity: "low",
  analyze(ctx) {
    return ctx.deps.serialChains
      .filter((c) => c.length >= 3)
      .map((chain) => {
        const first = ctx.ast.nodes.find((n) => n.id === chain[0])
        const last = ctx.ast.nodes.find((n) => n.id === chain.at(-1))
        return {
          ruleId: "SERIAL-001",
          severity: "low" as const,
          confidence: 0.95,
          location: { startLine: first?.startLine ?? 0, endLine: last?.endLine ?? 0 },
          evidence: [`${chain.length} 个调用构成 Explicit 数据依赖链（${chain.join(" → ")}）`],
          suggestion: "存在明确数据依赖，属合理串行；如需提速应缩短单次耗时或拆分任务粒度，而非并行化",
        }
      })
  },
}

/** SERIAL-002：并行候选（Candidate 置信度，需语义确认） */
export const parallelCandidate: AnalyzerRule = {
  id: "SERIAL-002",
  version: "1.0",
  severity: "medium",
  analyze(ctx) {
    return ctx.deps.candidates.map((c) => ({
      ruleId: "SERIAL-002",
      severity: "medium" as const,
      // 有 risk 的候选置信度下调（组内含动态/Explicit 节点）
      confidence: c.risk ? 0.4 : 0.7,
      location: { startLine: Math.min(...c.lines), endLine: Math.max(...c.lines) },
      evidence: [
        `${c.ids.length} 个调用源码相邻但无数据引用（${c.ids.join(", ")}）`,
        ...(c.risk ? [c.risk] : []),
      ],
      suggestion: "经语义确认业务独立后可改为 parallel；静态 Candidate 不构成自动并行化依据",
    }))
  },
}

/** TIMEOUT-001：agent 缺超时兜底 */
export const timeoutMissing: AnalyzerRule = {
  id: "TIMEOUT-001",
  version: "1.0",
  severity: "medium",
  analyze(ctx) {
    const findings: AnalyzerFinding[] = []
    // 粗粒度：统计 agent( 调用与 timeoutMs 出现次数
    const agentCount = (ctx.source.match(/\bagent\s*\(/g) ?? []).length
    const timeoutCount = (ctx.source.match(/timeoutMs\s*:/g) ?? []).length
    const runTimeout = /agentTimeoutMs|timeoutMs\s*:/.test(ctx.source)
    if (agentCount > 0 && timeoutCount === 0 && !runTimeout) {
      const first = ctx.ast.nodes.find((n) => n.kind === "agent")
      findings.push({
        ruleId: "TIMEOUT-001",
        severity: "medium",
        confidence: 0.75,
        location: { startLine: first?.startLine ?? 1, endLine: first?.endLine ?? 1 },
        evidence: [`${agentCount} 个 agent 调用均未声明 timeoutMs，且无 run 级超时`],
        suggestion: "长耗任务显式声明 timeoutMs（参考 workflow-authoring 默认 3600000），避免单点挂起拖垮整阶段",
      })
    }
    return findings
  },
}

/** RETRY-001：重试成本放大（retries 配置 × agent 数） */
export const retryCost: AnalyzerRule = {
  id: "RETRY-001",
  version: "1.0",
  severity: "low",
  analyze(ctx) {
    const retries = [...ctx.source.matchAll(/retries\s*:\s*(\d+)/g)].map((m) => Number(m[1]))
    if (retries.length === 0) return []
    const max = Math.max(...retries)
    if (max < 2) return []
    const agentCalls = ctx.graph.counts.agent ?? 0
    const first = ctx.ast.nodes.find((n) => n.kind === "agent")
    return [
      {
        ruleId: "RETRY-001",
        severity: "low" as const,
        confidence: 0.8,
        location: { startLine: first?.startLine ?? 1, endLine: first?.endLine ?? 1 },
        evidence: [`retries 最高 ${max} 次`, `agent 调用点 ${agentCalls} 个`, `失败场景最坏调用量 ≈ ${agentCalls * (max + 1)}`],
        suggestion: "全量失败时重试会造成成倍 token 消耗，配合 M3 任务级恢复只重跑失败任务",
      },
    ]
  },
}

/** DET-001：确定性操作可代码化（LLM 处理本可确定性完成的统计/过滤） */
export const deterministicCandidate: AnalyzerRule = {
  id: "DET-001",
  version: "1.0",
  severity: "low",
  analyze(ctx) {
    const patterns: Array<{ re: RegExp; hint: string }> = [
      { re: /agent\s*\(\s*[`'"][^`'"]*(统计|计数|去重|排序|编号|汇总数量)/, hint: "统计/计数/去重/排序类任务优先用 JS 确定性完成" },
      { re: /agent\s*\(\s*[`'"][^`'"]*(校验|核对格式|字段是否齐全)/, hint: "结构化字段校验可用 JS 完成" },
    ]
    const findings: AnalyzerFinding[] = []
    for (const { re, hint } of patterns) {
      const node = ctx.ast.nodes.find((n) => n.kind === "agent" && n.promptPreview && re.test(`agent(\`${n.promptPreview}`))
      if (node) {
        findings.push({
          ruleId: "DET-001",
          severity: "low",
          confidence: 0.5,
          location: { startLine: node.startLine, endLine: node.endLine },
          evidence: [`prompt 语义疑似确定性任务：${node.promptPreview}`],
          suggestion: hint,
        })
      }
    }
    return findings
  },
}

/** REC-001：大规模并行 + 无阶段边界（失败恢复成本高） */
export const recoveryRisk: AnalyzerRule = {
  id: "REC-001",
  version: "1.0",
  severity: "high",
  analyze(ctx) {
    const { total } = staticsOf(ctx)
    const phases = (ctx.source.match(/\bphase\s*\(/g) ?? []).length
    if (total >= 20 && phases === 0) {
      const first = ctx.ast.nodes[0]
      return [
        {
          ruleId: "REC-001",
          severity: "high" as const,
          confidence: 0.7,
          location: { startLine: first?.startLine ?? 1, endLine: first?.endLine ?? 1 },
          evidence: [`调用点 ${total} 个（≥20）且无 phase 阶段边界`, "无阶段边界时失败后只能整 run 重跑或依赖 journal 前缀回放"],
          suggestion: "用 phase() 划分阶段边界，配合 M3 TaskCheckpoint 实现任务级恢复（只重跑失败任务）",
        },
      ]
    }
    return []
  },
}

/** 内置规则集（顺序即报告顺序） */
export const BUILTIN_RULES: AnalyzerRule[] = [
  inputRepeat,
  concWaves,
  serialChain,
  parallelCandidate,
  timeoutMissing,
  retryCost,
  deterministicCandidate,
  recoveryRisk,
]
