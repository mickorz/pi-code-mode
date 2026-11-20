/**
 * 结果展示抽象（对齐 REF-001 `src/tui/result-view.ts` 的 FR-4/FR-5 语义）。
 *
 * 兼容点（JSON schema / structured 返回）：
 *   1. **structured 结果 pretty-print**：JSON.stringify(_, null, 2)，text 路径原样
 *   2. **渲染期脱敏**：命中 api_key/secret/token/password/authorization/credential 的字段
 *      替换为 [REDACTED]（只作用于渲染副本；journal 原值不动，resume 语义不变）
 *   3. **20KB 上限 + 截断提示**：UTF-8 安全截断，保留原始体积用于提示
 *   4. **空态三分**：error（失败）/ pending（运行中）/ empty（终态无结果）
 *   5. **preview 兜底**：journal 未写入结果时用节点快照预览（AgentRecord.outputPreview）
 *
 * 复用 `engine/runtime/agent-result.ts` 的 truncateUtf8ByBytes / redactValue，零重复实现。
 */

import { redactValue, truncateUtf8ByBytes } from "../../engine/runtime/agent-result.js"

/** 结果正文展示预算（与 REF-001 一致：20KB） */
export const RESULT_MAX_BYTES = 20 * 1024

export type ResultOutputType = "text" | "structured" | "unknown"

export interface ResultViewData {
  kind: "text" | "structured" | "raw"
  body: string
  /** 序列化前的原始体积（字节），截断提示用 */
  originalBytes: number
  truncated: boolean
}

export type ResultState =
  | { state: "error"; message: string }
  /** 运行中且尚无结果 */
  | { state: "pending" }
  /** 终态但无结果（失败无 result、schema 合法返回 null、或只记了执行历史） */
  | { state: "empty" }
  | { state: "content"; view: ResultViewData; source: "journal" | "preview" }

export interface ResultDetailInput {
  /** 节点状态（running/ok/failed/aborted…） */
  status: string
  error?: string
  /** journal 的 result；undefined = 未写入 */
  result?: unknown
  outputType?: ResultOutputType
  /** 节点快照的 2KB 预览（journal 未写入时的兜底） */
  outputPreview?: string
}

/** 结果正文格式化：text 原样 / structured JSON pretty-print（渲染前脱敏）/ 序列化失败退化 raw */
export function formatResultBody(value: unknown, outputType: ResultOutputType): ResultViewData {
  let kind: ResultViewData["kind"]
  let text: string
  if (outputType === "text" && typeof value === "string") {
    kind = "text"
    text = value
  } else {
    kind = outputType === "text" ? "raw" : "structured"
    try {
      const serialized = JSON.stringify(redactValue(value), null, 2)
      if (serialized === undefined) {
        kind = "raw"
        text = String(value)
      } else {
        text = serialized
      }
    } catch {
      kind = "raw"
      text = String(value)
    }
  }
  const originalBytes = Buffer.byteLength(text, "utf8")
  if (originalBytes <= RESULT_MAX_BYTES) return { kind, body: text, originalBytes, truncated: false }
  return { kind, body: truncateUtf8ByBytes(text, RESULT_MAX_BYTES), originalBytes, truncated: true }
}

/**
 * 结果展示状态判定（顺序即优先级）：
 *   failed  -> error（错误信息优先取节点 error）
 *   running -> pending
 *   有 result（非 null/undefined）-> content(journal)
 *   有 preview -> content(preview)
 *   否则 -> empty
 *
 * outputType 缺省时按值类型推断（老 journal 无该字段）。
 */
export function resolveResultState(input: ResultDetailInput): ResultState {
  // 注意状态词有两套来源：agent/workflow 用 failed|aborted|ok，
  // 工具节点（ToolExecutionRecord）用 ok|error|running —— 两套都要认，否则工具失败会显示成「无结果返回」
  if (input.status === "failed" || input.status === "error") {
    return { state: "error", message: input.error ?? "Agent failed" }
  }
  if (input.status === "running") return { state: "pending" }
  if (input.result != null) {
    const outputType: ResultOutputType =
      input.outputType === "text" || input.outputType === "structured"
        ? input.outputType
        : typeof input.result === "string"
          ? "text"
          : "structured"
    return { state: "content", view: formatResultBody(input.result, outputType), source: "journal" }
  }
  if (typeof input.outputPreview === "string" && input.outputPreview.length > 0) {
    return {
      state: "content",
      view: {
        kind: "text",
        body: input.outputPreview,
        originalBytes: Buffer.byteLength(input.outputPreview, "utf8"),
        truncated: false,
      },
      source: "preview",
    }
  }
  return { state: "empty" }
}
