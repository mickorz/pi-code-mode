/**
 * Patch Reviewer（O1）
 *
 * 职责：在补丁应用到工作区之后、用户 review 之前，按约束做一次独立审查。
 *
 * 与 Generator 分离的意义：生成者容易「自我感觉良好」。审查者只看 diff + 约束，
 * 更容易发现「改了无关代码」「行为等价性存疑」「破坏 Required Validation」。
 *
 * 档位已确认为 fast（按约束检查，不做深度推理）。
 */
import type { PatchReview, PatchSet } from "./session-types.js"

export interface PatchReviewerInput {
  patch: PatchSet
  /** 工作区应用 patch 后的文件全文 */
  afterFiles: Array<{ path: string; before: string; after: string }>
  requiredValidation: string[]
  clusters: Array<{ ruleId: string; evidence: string[]; suggestion?: string }>
}

export function buildPatchReviewerPrompt(input: PatchReviewerInput): string {
  const diffs = input.afterFiles
    .map((f) => `### 文件 ${f.path}\n--- before ---\n${f.before}\n--- after ---\n${f.after}`)
    .join("\n\n")

  const intent = input.patch.files
    .flatMap((f) => f.edits.map((e) => `- ${f.path} L${e.startLine}-${e.endLine}（簇 ${e.relatedCluster}）：${e.rationale}`))
    .join("\n")

  const required =
    input.requiredValidation.length > 0 ? input.requiredValidation.map((v, i) => `${i + 1}. ${v}`).join("\n") : "（无）"

  return `你是 Workflow JS 补丁审查者。任务：判断该补丁是否**只做了它声称要做的事**，且没有引入行为风险。

## 补丁声明
${intent}

## Required Validation（补丁后必须仍满足）
${required}

## 补丁前后完整内容
${diffs}

## 审查要点
1. 是否改动了与声明无关的代码（含注释、格式、导出、常量）？
2. 是否可能改变运行行为（顺序、并发、错误处理、返回结构、文件路径）？
3. 是否破坏 Required Validation？
4. 是否存在未处理的边界（空数组、缺失文件、异常分支）？

## 输出（只输出 JSON，不要围栏，不要解释）
{"decision":"approve|reject|needs-human","findings":[{"severity":"high|medium|low","file":"<路径>","evidence":"<引文>","reason":"<原因>"}]}

判定标准：
- approve：只改了声明范围，行为等价或明确更优，Required Validation 不受影响
- reject：改动了无关代码，或存在明确行为风险
- needs-human：无法仅凭 diff 判断（如依赖运行时语义）`
}

export function parsePatchReview(raw: string): { ok: boolean; review?: PatchReview; error?: string } {
  const text = String(raw ?? "").trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start < 0 || end <= start) return { ok: false, error: "输出中找不到 JSON 对象" }
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1))
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${String((e as Error)?.message ?? e)}` }
  }
  const obj = parsed as Partial<PatchReview>
  if (!obj.decision || !["approve", "reject", "needs-human"].includes(obj.decision)) {
    return { ok: false, error: `decision 非法：${String(obj.decision)}` }
  }
  return {
    ok: true,
    review: {
      decision: obj.decision,
      findings: Array.isArray(obj.findings)
        ? obj.findings.map((f) => ({
            severity: (f?.severity ?? "low") as "high" | "medium" | "low",
            file: String(f?.file ?? ""),
            evidence: String(f?.evidence ?? ""),
            reason: String(f?.reason ?? ""),
          }))
        : [],
    },
  }
}

export async function reviewPatch(
  input: PatchReviewerInput,
  agent: (prompt: string) => Promise<string>,
): Promise<{ ok: boolean; review?: PatchReview; promptLength: number; error?: string }> {
  const prompt = buildPatchReviewerPrompt(input)
  try {
    const raw = await agent(prompt)
    const parsed = parsePatchReview(raw)
    return { ...parsed, promptLength: prompt.length }
  } catch (e) {
    return { ok: false, promptLength: prompt.length, error: String((e as Error)?.message ?? e) }
  }
}
