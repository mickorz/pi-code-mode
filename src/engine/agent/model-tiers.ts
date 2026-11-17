/**
 * Model Tier 分层配置（P1-3）
 *
 * 加载流程：
 *  全局 ~/.config/opencode/workflows/model-tiers.json
 *   -> 项目 <projectDir>/.opencode-workflows/model-tiers.json（同名键覆盖全局）
 *   -> 合并结果：tier 名 -> "provider/modelId"
 *
 * 配置示例：
 *  { "tiers": { "small": "openai/gpt-4o-mini", "medium": "anthropic/claude-sonnet-4-6", "big": "anthropic/claude-opus-4" } }
 *
 * 与需求文档 D-08 的偏差说明：Pi 版本带"按价格/名字启发式动态排序自动生成分层"，
 * 插件上下文无模型价格注册表（需额外 API 轮询 models.dev 数据），此处仅做配置文件解析；
 * 未配置的 tier 回退会话默认模型并告警（回退语义与 Pi 一致）。动态分层待真实需求再评估。
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** tier 名 -> "provider/modelId" 或模型池条目数组的映射表（v2 池化向后兼容 v1 字符串） */
export type ModelTiers = Record<string, string | TierModelEntry[]>

/** 池条目：模型 + 可选并发上限（v2） */
export interface TierModelEntry {
  model: string
  concurrency?: number
}

interface TierConfigFile {
  tiers?: Record<string, string | TierModelEntry[]>
}

function readTierKeys(file: string | undefined): ModelTiers {
  if (!file) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<TierConfigFile>
    if (raw && typeof raw === "object" && raw.tiers && typeof raw.tiers === "object") {
      const out: ModelTiers = {}
      for (const [tier, model] of Object.entries(raw.tiers)) {
        if (typeof model === "string" && model.trim()) {
          out[tier] = model.trim()
        } else if (Array.isArray(model)) {
          // v2 池条目：过滤非法项，全非法则丢弃该档（告警由调用方 resolveTier 回退语义覆盖）
          const entries = model
            .filter((e) => e && typeof e === "object" && typeof (e as TierModelEntry).model === "string" && (e as TierModelEntry).model.trim())
            .map((e) => ({ model: (e as TierModelEntry).model.trim(), concurrency: (e as TierModelEntry).concurrency }))
          if (entries.length) out[tier] = entries
        }
      }
      return out
    }
  } catch {
    // 文件不存在或损坏：视为未配置
  }
  return {}
}

/** 加载 tier 配置：全局 + 项目 overlay（项目同名键覆盖全局） */
export function loadModelTiers(options: { globalFile?: string; projectDir?: string } = {}): ModelTiers {
  const globalFile = options.globalFile ?? path.join(os.homedir(), ".pi", "workflows", "model-tiers.json")
  // 项目级双路径兼容：pi 约定 .pi/workflows/ 优先，opencode 兼容路径随后覆盖（与 workflow 目录策略一致）
  const compatFile = options.projectDir
    ? path.join(options.projectDir, ".opencode-workflows", "model-tiers.json")
    : undefined
  const projectFile = options.projectDir
    ? path.join(options.projectDir, ".pi", "workflows", "model-tiers.json")
    : undefined
  return { ...readTierKeys(globalFile), ...readTierKeys(compatFile), ...readTierKeys(projectFile) }
}
