/**
 * 结构化输出校验（R3 M2：完整 Schema DSL 的校验面）
 *
 * schema 为 JSON Schema 字面量（与 opencode 版 format: json_schema 同形态），
 * 用 typebox/value 的 Check 校验（TypeBox 对 JSON Schema 形态直接兼容）。
 * 修复循环的 LLM 轮次在 PiAgentAdapter.execute 内（校验失败把错误清单附回 prompt 重试）。
 */

import { Value } from "typebox/value"

export interface StructuredValidation {
  ok: boolean
  value?: unknown
  /** 校验失败时的错误清单（喂回模型做修复轮） */
  errors?: string[]
}

export function validateStructured(rawText: string, schema: object): StructuredValidation {
  // 1. 剥 markdown 围栏后解析 JSON
  const stripped = rawText.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim()
  let value: unknown
  try {
    value = JSON.parse(stripped)
  } catch (e) {
    return { ok: false, errors: [`输出不是合法 JSON（${String((e as Error).message).slice(0, 120)}）。只输出 JSON 对象本身，不要任何解释文字或代码围栏。`] }
  }
  // 2. JSON Schema 校验
  try {
    if (Value.Check(schema as any, value)) return { ok: true, value }
    const errors = [...Value.Errors(schema as any, value)].map((e) => e.message ?? "校验失败")
    return {
      ok: false,
      errors: errors.length ? errors : ["输出不符合 schema 结构"],
    }
  } catch (e) {
    // schema 本身不可校验（非法 schema）按解析成功透传，由上层决定
    return { ok: true, value }
  }
}
