/**
 * AI Rule Check Prompt 构造
 *
 * 与 Planner prompt 的本质区别：这里要求模型**按规则文档独立判定**每条规则，
 * 而不是"基于已给结论提建议"。所以：
 *  - 必须给规则文档全文（基准）
 *  - 必须给源码（证据来源）
 *  - 必须要求 quote（可核对）
 *  - 不允许模型编造，不确定就 uncertain
 *
 * 体积控制（实测教训：prompt 形态不对会让 reasoning 模型零输出）：
 *  - 源码只给「调用点/关键行窗口」而非整文件
 *  - 输出格式用 JSON 示例，不用 TS schema 描述
 */
import path from "node:path"

import type { AIRuleCheckRule } from "./types.js"

/** 参与检查的源码文件（路径 + 内容） */
export interface SourceFile {
  /** 报告里展示的相对路径（正斜杠） */
  file: string
  content: string
}

export interface SourceContextOptions {
  /** 每个关键行前后各取多少行 */
  window?: number
  /** 单个文件最多给多少个窗口（防止大文件撑爆 prompt） */
  maxWindowsPerFile?: number
}

/** 关键行：agent / workflow / parallel / phase / retries / timeoutMs / setConcurrency / impactSet */
const KEY_LINE_RE =
  /\b(agent|workflow|parallel|pipeline|phase|retries|timeoutMs|setConcurrency|readBack|echoWrite|impactSet|checkpoint)\b/

/**
 * 构造紧凑源码上下文：只给关键行窗口 + 行号。
 * 不塞整份源码——12 文件 3500 行会到 100k 字符，模型会长时间无输出。
 */
export function buildSourceContext(files: SourceFile[], opts: SourceContextOptions = {}): string {
  // 实测：12 文件 × 24 窗口会让语义规则组 300s 无返回。收到 2 行窗口 × 10 处足够定位证据。
  const window = opts.window ?? 2
  const maxWindowsPerFile = opts.maxWindowsPerFile ?? 10
  const out: string[] = []

  for (const f of files) {
    const lines = f.content.split("\n")
    const keyLines: number[] = []
    for (let i = 0; i < lines.length; i++) {
      if (KEY_LINE_RE.test(lines[i]!)) keyLines.push(i + 1)
    }
    if (keyLines.length === 0) {
      out.push(`### ${f.file}（${lines.length} 行，无关键行）`)
      continue
    }
    // 合并相近窗口，避免同一段重复输出
    const picked = new Set<number>()
    for (const ln of keyLines.slice(0, maxWindowsPerFile)) {
      for (let d = -window; d <= window; d++) {
        const n = ln + d
        if (n >= 1 && n <= lines.length) picked.add(n)
      }
    }
    const sorted = [...picked].sort((a, b) => a - b)
    const segments: string[] = []
    let prev = -2
    let buf: string[] = []
    for (const n of sorted) {
      if (n !== prev + 1 && buf.length > 0) {
        segments.push(buf.join("\n"))
        buf = []
      }
      buf.push(`${String(n).padStart(4)}| ${lines[n - 1] ?? ""}`)
      prev = n
    }
    if (buf.length > 0) segments.push(buf.join("\n"))
    out.push(`### ${f.file}（${lines.length} 行，关键行 ${keyLines.length} 处）`)
    out.push(segments.join("\n   ...\n"))
  }
  return out.join("\n\n")
}

export interface AIRuleCheckPromptInput {
  rules: AIRuleCheckRule[]
  sourceContext: string
  /** 静态分析已确认的事实（供 AI 交叉参考，不允许它推翻结构事实） */
  staticSummary: string
}

/** 输出格式示例（照抄结构，不用 schema 描述——实测后者会让模型零输出） */
export const RULE_CHECK_OUTPUT_EXAMPLE = JSON.stringify(
  {
    checks: [
      {
        ruleId: "REC-002",
        status: "hit",
        confidence: 0.9,
        reason: "mode=retry 分支读取了 impact.impactSet，但 runStage 传的是 stageResults.impactSet（未赋值）",
        impact: "retry 可能退化为普通端级重跑",
        suggestion: "改为 const retryImpactSet = mode==='retry' ? impact.impactSet : null 并显式传递",
        validation: ["构造 impact-set.json 后跑 mode=retry，断言子 workflow 收到的集合一致"],
        evidence: [
          {
            file: "game-requirement-audit.js",
            startLine: 470,
            endLine: 476,
            quote: "impactSet: stageResults.impactSet || null",
          },
        ],
      },
    ],
  },
  null,
  0,
)

export function buildRuleCheckPrompt(input: AIRuleCheckPromptInput): string {
  const ruleDocs = input.rules
    .map((r) => `### 规则 ${r.id}（${r.severity}）\n${r.doc.trim()}`)
    .join("\n\n")

  return `你是 Workflow 代码规则检查器。任务：严格按下面给出的规则文档，检查 workflow 源码是否命中这些规则。

**这是代码检查，不是写优化建议。** 只依据规则文档判断，不要引入规则文档之外的标准。

## 规则文档（判断基准）
${ruleDocs}

## 静态分析已确认的事实（供参考，不允许你推翻）
${input.staticSummary || "（无）"}

## 源码上下文（格式为「行号| 代码」，... 表示省略）
${input.sourceContext}

## 判断规则
1. 每条规则都必须给出结论：hit / pass / uncertain / not-applicable。
2. hit 必须给出至少一条 evidence：file、startLine、endLine、quote；**每条规则最多 3 条 evidence**（挑最典型的）。
3. quote 必须是源码里**逐字存在**的片段（会做程序化校验，编造会被丢弃）。
4. 证据不足时给 uncertain，不要猜；规则与该代码无关时给 not-applicable。
5. confidence 用 0..1；低于 0.5 会被降级为 uncertain。
6. 不要输出具体性能收益数字（没有 Benchmark 基线）。
7. 只输出 JSON，不要 markdown 围栏，不要解释文字。

## 输出格式（照抄这个结构）
${RULE_CHECK_OUTPUT_EXAMPLE}`
}

/** 把多文件源码整理成 SourceFile[]（统一正斜杠路径） */
export function toSourceFiles(entries: Array<{ file: string; content: string }>): SourceFile[] {
  return entries.map((e) => ({ file: e.file.split(path.sep).join("/"), content: e.content }))
}
