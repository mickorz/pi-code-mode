/**
 * Task Fingerprint（M3-T3）：任务级分层指纹
 *
 * taskFingerprint = hash({
 *   taskKey,
 *   taskDefinitionHash,      // 任务定义（prompt 模板 / 调用形态）
 *   inputHash,               // 输入数据指纹
 *   promptHash,              // 最终 prompt 指纹
 *   modelConfigHash,         // 模型 ID + 关键参数（不能只比模型名）
 *   executionContractVersion,// 输出契约版本
 *   externalDepsHash,        // 外部依赖指纹（**按任务实际依赖逐项**计算）
 * })
 *
 * 设计要点（五轮评审）：
 *  - 整体 scriptHash 不参与复用判定（改一行日志不应使全部产物失效）
 *  - externalDepsHash 只含该任务实际依赖（客户端任务不因规则文档变化而失效）
 *  - workflowVersionHash（整体 scriptHash）单独记录，仅审计与 Plan 过期检测
 */
import { createHash } from "node:crypto"

import { canonicalJSON } from "../plan/source-fingerprint.js"

export interface TaskFingerprintInput {
  taskKey: string
  taskDefinitionHash?: string
  inputHash?: string
  promptHash?: string
  modelConfigHash?: string
  executionContractVersion?: string
  /** 任务级外部依赖：{ 依赖名 → 快照指纹 }（仅含该任务实际依赖） */
  externalDeps?: Record<string, string>
}

export interface TaskFingerprint {
  taskKey: string
  /** 完整指纹（复用判定依据） */
  fingerprint: string
  /** 分项（排查/展示用） */
  parts: {
    taskDefinitionHash: string
    inputHash: string
    promptHash: string
    modelConfigHash: string
    executionContractVersion: string
    externalDepsHash: string
  }
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`
}

/** 内容指纹（缺省空串 → 稳定值，便于部分字段缺失时仍可判定） */
export function contentHash(value: unknown): string {
  if (value === undefined || value === null) return sha256("")
  if (typeof value === "string") return sha256(value)
  return sha256(canonicalJSON(value))
}

/** 模型配置指纹：模型 ID + 影响输出的关键参数（temperature/maxTokens/thinking 等） */
export function modelConfigHash(input: { model?: string; params?: Record<string, unknown> }): string {
  return contentHash({ model: input.model ?? "", params: input.params ?? {} })
}

/** 任务级外部依赖指纹：只对该任务声明的依赖项求哈希（键序无关） */
export function externalDepsHash(deps: Record<string, string> | undefined): string {
  return contentHash(Object.fromEntries(Object.entries(deps ?? {}).sort(([a], [b]) => a.localeCompare(b))))
}

export function computeTaskFingerprint(input: TaskFingerprintInput): TaskFingerprint {
  const parts = {
    taskDefinitionHash: input.taskDefinitionHash ?? sha256(""),
    inputHash: input.inputHash ?? sha256(""),
    promptHash: input.promptHash ?? sha256(""),
    modelConfigHash: input.modelConfigHash ?? sha256(""),
    executionContractVersion: input.executionContractVersion ?? "v1",
    externalDepsHash: externalDepsHash(input.externalDeps),
  }
  const fingerprint = sha256(canonicalJSON({ taskKey: input.taskKey, ...parts }))
  return { taskKey: input.taskKey, fingerprint, parts }
}

/** 从 Plan/脚本整体生成 workflowVersionHash（仅审计，不参与复用） */
export function workflowVersionHash(scriptSource: string): string {
  return sha256(scriptSource)
}
