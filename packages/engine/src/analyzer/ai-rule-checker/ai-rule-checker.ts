/**
 * AI Rule Checker 主流程
 *
 * 分组策略（实测取舍）：
 *  - 不用「9 条规则 9 次调用」：9 倍等待 + 无法共享上下文
 *  - 也不用「一次全查」：输出过长会让 reasoning 模型耗时剧烈波动
 *  - 用 2 组（结构类 / 语义类），并发 2（符合项目真实模型联调并发上限）
 *
 * 失败语义：
 *  - 单组失败 → 该组规则记 error，其余保留
 *  - 全部失败 → status=failed，静态报告仍然可用
 */
import { randomUUID } from "node:crypto"

import type { AIRuleCheck, AIRuleCheckResult, AIRuleCheckRule } from "./types.js"
import { buildRuleCheckPrompt, buildSourceContext, type SourceFile } from "./prompt-builder.js"
import { validateCheck } from "./evidence-validator.js"

type PlannerAgent = (prompt: string) => Promise<string>

/**
 * 分组：**一条规则一组**（9 次调用，并发 3）。
 *
 * 实测演进（都跑在真实 game-requirement-audit 上）：
 *  2 组（5+4 条规则）→ 语义组 300s 无返回
 *  3 组（3+4+2）   → 含 4 条规则的组仍超时
 *  4 组（2~3 条）  → 仍有组随机超时（模型端波动，不是 prompt 大小单一因素）
 *  1 条/组         → 单次 prompt 最小，单次耗时可控，且单条失败只影响 1 条规则
 *
 * 代价是 9 次调用；但每次输入只有 1 份规则文档 + 精简源码窗口，总 token 反而更省。
 */
function groupRules(rules: AIRuleCheckRule[]): AIRuleCheckRule[][] {
  return rules.map((r) => [r])
}

/** 从模型输出里抠 JSON（容忍围栏与前后文字） */
export function parseChecks(raw: string): { ok: boolean; checks: AIRuleCheck[]; error?: string } {
  const text = String(raw ?? "").trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start < 0 || end <= start) return { ok: false, checks: [], error: "输出中找不到 JSON 对象" }
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1))
  } catch (e) {
    return { ok: false, checks: [], error: `JSON 解析失败：${String((e as Error)?.message ?? e)}` }
  }
  const obj = parsed as { checks?: unknown }
  if (!Array.isArray(obj.checks)) return { ok: false, checks: [], error: "缺少 checks 数组" }

  const checks: AIRuleCheck[] = []
  for (const [i, item] of obj.checks.entries()) {
    const c = item as Record<string, unknown>
    const ruleId = String(c.ruleId ?? "")
    const status = String(c.status ?? "")
    if (!ruleId) continue
    if (!["hit", "pass", "uncertain", "not-applicable", "error"].includes(status)) continue
    const rawEvidence = Array.isArray(c.evidence) ? c.evidence : []
    const evidence = rawEvidence
      .map((e) => e as Record<string, unknown>)
      .map((e) => ({
        file: String(e.file ?? ""),
        startLine: Number(e.startLine ?? 0),
        endLine: Number(e.endLine ?? e.startLine ?? 0),
        quote: String(e.quote ?? ""),
      }))
      .filter((e) => e.file && Number.isFinite(e.startLine) && e.startLine > 0)
    checks.push({
      ruleId,
      status: status as AIRuleCheck["status"],
      confidence: Math.max(0, Math.min(1, Number(c.confidence ?? 0.5))),
      source: "ai",
      evidence,
      reason: String(c.reason ?? ""),
      ...(c.impact ? { impact: String(c.impact) } : {}),
      ...(c.suggestion ? { suggestion: String(c.suggestion) } : {}),
      ...(Array.isArray(c.validation) ? { validation: (c.validation as unknown[]).map(String) } : {}),
    })
    void i
  }
  return { ok: checks.length > 0, checks, ...(checks.length === 0 ? { error: "checks 为空" } : {}) }
}

export interface RunAIRuleCheckInput {
  rules: AIRuleCheckRule[]
  sources: SourceFile[]
  staticSummary: string
  plannerAgent: PlannerAgent
  /** 并发上限（默认 4：默认只跑 6 条语义规则，2 轮完成） */
  concurrency?: number
  /** 单组超时（毫秒）；调用方也可从 plannerAgent 侧施加 */
  groupTimeoutMs?: number
}

/** 简单并发闸门：避免 2 组同时压满模型通道 */
async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const idx = cursor++
      results[idx] = await tasks[idx]!()
    }
  })
  await Promise.all(workers)
  return results
}

export async function runAIRuleCheck(input: RunAIRuleCheckInput): Promise<AIRuleCheckResult> {
  const { rules, sources, staticSummary, plannerAgent } = input
  if (rules.length === 0) {
    return { status: "skipped", checks: [], diagnostics: ["没有可用的规则文档，AI Rule Check 跳过"] }
  }
  const t0 = Date.now()
  const sourceContext = buildSourceContext(sources)
  const groups = groupRules(rules)
  const diagnostics: string[] = []

  const tasks = groups.map((group) => async (): Promise<AIRuleCheck[]> => {
    const prompt = buildRuleCheckPrompt({ rules: group, sourceContext, staticSummary })
    const runId = randomUUID().slice(0, 8)
    try {
      const raw = await plannerAgent(prompt)
      const parsed = parseChecks(raw)
      if (!parsed.ok) {
        diagnostics.push(`AI 规则组[${group.map((r) => r.id).join(",")}] 输出不可用：${parsed.error}`)
        return group.map((r) => ({
          ruleId: r.id,
          status: "error" as const,
          confidence: 0,
          source: "ai" as const,
          evidence: [],
          reason: "",
          error: `输出不可用：${parsed.error}`,
        }))
      }
      const out: AIRuleCheck[] = []
      for (const rule of group) {
        const found = parsed.checks.find((c) => c.ruleId === rule.id)
        if (!found) {
          out.push({
            ruleId: rule.id,
            status: "error",
            confidence: 0,
            source: "ai",
            evidence: [],
            reason: "",
            error: "模型未返回该规则的结论",
          })
          continue
        }
        const { check, dropped } = validateCheck(found, sources)
        for (const d of dropped) diagnostics.push(`[${rule.id}] 证据丢弃：${d}`)
        out.push(check)
      }
      void runId
      return out
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 200)
      diagnostics.push(`AI 规则组[${group.map((r) => r.id).join(",")}] 调用失败：${msg}`)
      return group.map((r) => ({
        ruleId: r.id,
        status: "error" as const,
        confidence: 0,
        source: "ai" as const,
        evidence: [],
        reason: "",
        error: msg,
      }))
    }
  })

  const results = await runWithConcurrency(tasks, input.concurrency ?? 4)
  const checks = results.flat()
  const errorCount = checks.filter((c) => c.status === "error").length
  const status: AIRuleCheckResult["status"] =
    errorCount === 0 ? "completed" : errorCount === checks.length ? "failed" : "partial"

  return { status, checks, diagnostics, durationMs: Date.now() - t0 }
}
