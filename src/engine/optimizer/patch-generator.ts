/**
 * Patch Generator（O1）
 *
 * 职责：把**选中的问题簇**变成结构化 PatchSet（最小范围）。
 *
 * 硬约束（写进 prompt，且在 validator 中二次强制）：
 *  - 禁止输出整文件，只输出 PatchSet JSON
 *  - 每个 oldText 必须来自给定源码且唯一
 *  - 不改未列出文件、不改 Required Validation
 *  - 不确定输出 needsHumanDecision，不猜
 *
 * 模型档位由调用方传入（已确认：generator=big / reviewer=fast）。
 */
import { repairTruncatedJson } from "../analyzer/optimization-planner.js"
import type { AnalysisReport, FindingCluster } from "../analyzer/report-builder.js"
import type { PatchSet } from "./session-types.js"

export interface PatchGeneratorInput {
  clusters: FindingCluster[]
  /**
   * 受影响文件内容。**优先只传证据附近窗口**：实测单文件全文（~180 行）+ 规则文档
   * 会让 big 档超过 240s 超时；窗口化后 prompt 从 ~20k 降到 ~6k。
   */
  files: Array<{
    path: string
    content: string
    hash: string
    /** 片段在文件中的起始行（1-based）；缺省表示 content 为全文 */
    snippetStart?: number
    /** 片段结束行（1-based） */
    snippetEnd?: number
    /** 文件总行数（片段模式下用于说明边界） */
    totalLines?: number
  }>
  /** 相关规则文档全文（触发规则） */
  ruleDocs: Array<{ id: string; doc: string }>
  /** Required Validation（Plan 提取；没有则空） */
  requiredValidation: string[]
  report: AnalysisReport
}

const OUTPUT_EXAMPLE = JSON.stringify(
  {
    schemaVersion: "1.0",
    targetRoot: ".",
    files: [
      {
        path: "4-client-verify.js",
        expectedSourceHash: "sha256:...",
        edits: [
          {
            startLine: 339,
            endLine: 352,
            newText: "const fileList = readEvidenceFiles(runDir)",
            rationale: "该 agent 只做「读取目录下 *-cp*.json 分片 + 提取 file 字段 + 去重」，属确定性 JSON 处理",
            relatedCluster: "DET-001",
          },
          {
            startLine: 460,
            endLine: 462,
            newText: "function readEvidenceFiles(runDir) {\n  /* 确定性实现 */\n  return []\n}\n",
            rationale: "新增确定性辅助函数",
            relatedCluster: "DET-001",
          },
        ],
      },
    ],
  },
  null,
  1,
)

export function buildPatchGeneratorPrompt(input: PatchGeneratorInput): string {
  const clusters = input.clusters
    .map(
      (c) =>
        `### 问题簇 ${c.ruleId}（${c.count} 处，严重度 ${c.severity}）\n` +
        `- 位置：${c.locations.join("；")}\n` +
        `- 证据：\n${c.evidence.map((e) => `  - ${e}`).join("\n")}\n` +
        (c.suggestion ? `- 静态建议：${c.suggestion}\n` : ""),
    )
    .join("\n")

  const docs = input.ruleDocs.map((r) => `### 规则 ${r.id}\n${r.doc.trim()}`).join("\n\n")
  const files = input.files
    .map((f) => {
      const range =
        f.snippetStart !== undefined && f.snippetEnd !== undefined
          ? `\n（以下仅为文件第 ${f.snippetStart}-${f.snippetEnd} 行，全文共 ${f.totalLines ?? "?"} 行；只能改这个区间内的代码）`
          : ""
      return `### 文件 ${f.path}（hash ${f.hash}）${range}\n\`\`\`js\n${f.content}\n\`\`\``
    })
    .join("\n\n")

  const required =
    input.requiredValidation.length > 0
      ? input.requiredValidation.map((v, i) => `${i + 1}. ${v}`).join("\n")
      : "（无 Plan Required Validation）"

  return `你是 Workflow JS 补丁生成器。任务：针对下面**已选中的问题簇**，生成**最小范围**的结构化补丁。

## 硬性约束（违反任一条会被程序拒绝）
1. 只输出 JSON，不要 markdown 围栏，不要解释文字。
2. **禁止输出完整文件内容**。只能用 edits 里的 oldText/newText 做局部替换。
3. **用行号定位**：只给 startLine/endLine 与 newText，不要回传原代码（oldText 可省略）。
   行号必须精确指向要替换的完整语句块；程序会用该行区间切片做替换。
   若你给了 oldText，它必须与该行区间内容一致（否则会被拒绝）。
4. 只能修改下面列出的文件；不得新增文件、不得重命名、不得改动未列出的文件。
5. 不得删除或弱化 export const meta。
6. 不得引入新依赖；不得修改 Plan Required Validation。
7. **允许在同一个文件内新增辅助函数**：常见改法是「用 2 个 edit 完成」——
   ① 把 agent 调用替换成对新函数的调用；② 在文件末尾（return 之前）追加该函数定义。
   不要因为「需要新函数」就放弃生成补丁。
8. **files 为空时，必须给出 needsHumanDecision 说明原因**（例如需要改多个文件、需要改运行时时序、
   或该处无法在不改变行为的前提下局部替换）。不允许静默返回空补丁。
9. **输出预算**：单次补丁的所有 newText 合计不超过 60 行。
   若最小可行改动会超过这个规模，请在 needsHumanDecision 里说明「需分步优化」并建议拆分方式，
   而不是一次输出大段代码（实测超过 60 行会因生成时间过长而超时）。
10. 不确定时输出 needsHumanDecision（说明问题与选项），不要猜。

## 已选问题簇
${clusters}

## 规则基准
${docs}

## Required Validation（补丁后必须仍然满足）
${required}

## 允许修改的文件
${files}

## 输出格式（照抄结构）
${OUTPUT_EXAMPLE}

注意：expectedSourceHash 必须填上面每个文件标题里给出的 hash 原值。

如果需要新增辅助函数，用两个 edit（同一文件内）：
1. 替换调用点：oldText = 原 agent(...) 调用原文，newText = 调用新函数
2. 追加定义：oldText = 文件末尾某个唯一锚点（如最后的 return 行），newText = 锚点 + 新函数定义
两个 edit 的行区间不能重叠。行号请从源码上下文标注的行号读取（片段模式下注意起始行偏移）。`
}

/** needsHumanDecision 归一化：字符串 → 单条说明；对象 → 单条；数组 → 逐条 */
function normalizeNeedsHumanDecision(raw: unknown): NonNullable<PatchSet["needsHumanDecision"]> {
  if (typeof raw === "string" && raw.trim()) {
    return [{ cluster: "（未指定）", question: raw.trim(), options: [] }]
  }
  if (Array.isArray(raw)) {
    return raw
      .map((x) => (typeof x === "string" ? { cluster: "（未指定）", question: x, options: [] } : (x as Record<string, unknown>)))
      .map((x) => ({
        cluster: String(x.cluster ?? "（未指定）"),
        question: String(x.question ?? ""),
        options: Array.isArray(x.options) ? (x.options as unknown[]).map(String) : [],
      }))
      .filter((x) => x.question)
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>
    if (o.question !== undefined || o.cluster !== undefined) {
      return [
        {
          cluster: String(o.cluster ?? "（未指定）"),
          question: String(o.question ?? ""),
          options: Array.isArray(o.options) ? (o.options as unknown[]).map(String) : [],
        },
      ]
    }
  }
  return []
}

/** 从模型输出抠 PatchSet JSON */
export function parsePatchSet(raw: string): { ok: boolean; patch?: PatchSet; error?: string } {
  const text = String(raw ?? "").trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start < 0 || end <= start) return { ok: false, error: "输出中找不到 JSON 对象" }
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1))
  } catch (firstErr) {
    // 严格解析 → 截断修复：实测 fast 档生成 PatchSet 时会在数组元素分隔处被截断
    // （Expected ',' or ']' after array element），一失败就丢掉整个候选太浪费。
    // 复用 Planner 的修复器：补齐未闭合字符串/括号 + 修剪残缺 key。
    // 即使修出不完整内容也没关系——validatePatchSet 会二次校验后拒绝。
    const repaired = repairTruncatedJson(candidate.slice(start))
    if (!repaired) {
      return { ok: false, error: `JSON 解析失败：${String((firstErr as Error)?.message ?? firstErr)}` }
    }
    try {
      parsed = JSON.parse(repaired)
    } catch (e) {
      return { ok: false, error: `JSON 解析失败（截断修复后仍失败）：${String((e as Error)?.message ?? e)}` }
    }
  }
  const obj = parsed as Record<string, unknown>
  const rawNhd = obj.needsHumanDecision
  /**
   * 实测：模型经常把 needsHumanDecision 写成**字符串**（一段完整的人工决策说明），
   * 而不是 [{cluster,question,options}]。这是「为什么不能改」的高价值输出，
   * 因为格式不一致就丢掉它，等于把最该看的结论扔了。
   */
  const nhd = normalizeNeedsHumanDecision(rawNhd)
  if (!Array.isArray(obj.files) && nhd.length === 0) {
    return { ok: false, error: "既没有 files 也没有 needsHumanDecision" }
  }
  return {
    ok: true,
    patch: {
      schemaVersion: (obj.schemaVersion ?? "1.0") as "1.0",
      targetRoot: String(obj.targetRoot ?? "."),
      files: Array.isArray(obj.files) ? (obj.files as PatchSet["files"]) : [],
      ...(nhd.length > 0 ? { needsHumanDecision: nhd } : {}),
    },
  }
}

/** 生成补丁（模型由调用方注入，便于测试与档位解耦） */
export async function generatePatchSet(
  input: PatchGeneratorInput,
  agent: (prompt: string) => Promise<string>,
): Promise<{ ok: boolean; patch?: PatchSet; promptLength: number; error?: string; raw?: string }> {
  const prompt = buildPatchGeneratorPrompt(input)
  try {
    const raw = await agent(prompt)
    const parsed = parsePatchSet(raw)
    return { ...parsed, promptLength: prompt.length, raw }
  } catch (e) {
    return { ok: false, promptLength: prompt.length, error: String((e as Error)?.message ?? e) }
  }
}
