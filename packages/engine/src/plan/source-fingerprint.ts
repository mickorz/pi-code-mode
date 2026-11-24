/**
 * Plan 指纹计算（M1-T1）
 *
 * planHash = SHA256(canonicalJSON(Plan without planHash))
 * 参与：planVersion / source.scriptHash / definition / profiles / workflowId / name
 * 不参与：planHash（自引用）/ source.analyzedAt（报告元数据）
 *
 * profileHash = SHA256(canonicalJSON(definition 之外的该 Profile + 其解析后的有效策略))
 * scriptHash = SHA256(脚本源码)
 */
import { createHash } from "node:crypto"

/** 稳定序列化：对象键排序、剔除 undefined，保证同内容同 hash */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k]
      if (val !== undefined) out[k] = sortDeep(val)
    }
    return out
  }
  return v
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`
}

/** 脚本内容指纹 */
export function hashScript(source: string): string {
  return sha256(source)
}

/** Plan 内容指纹：剔除 planHash 与 analyzedAt 后哈希 */
export function hashPlan(plan: unknown): string {
  const clone = JSON.parse(JSON.stringify(plan)) as Record<string, any>
  delete clone.planHash
  if (clone.source && typeof clone.source === "object") delete clone.source.analyzedAt
  return sha256(canonicalJSON(clone))
}

/** 单 Profile 指纹（含其差异策略） */
export function hashProfile(plan: unknown, profileName: string): string {
  const clone = JSON.parse(JSON.stringify(plan)) as Record<string, any>
  delete clone.planHash
  return sha256(canonicalJSON({ workflowId: clone.workflowId, definition: clone.definition, profile: clone.profiles?.[profileName] ?? {} }))
}
