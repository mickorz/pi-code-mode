/**
 * 模型串解析（P2 池化前置）：把 "provider/model[:thinking]" 解析成宿主 Model 对象。
 *
 * 现状缺口修复：PiAgentAdapter 此前不消费 request.model（tier 只做元数据标注），本模块
 * 打通最后一环——经 ModelRuntime 注册表查到 Model 后传入 createAgentSession({ model })。
 *
 * 查询不到时返回 warning 并回退会话默认模型（与 P1-3 "tier 未配置回退" 语义一致）；
 * 解析栈借鉴 pi-dynamic-workflows src/model-spec.ts（REF-002，裁剪版）。
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { Model } from "@earendil-works/pi-ai"

let sharedRuntime: Promise<ModelRuntime> | undefined

/** 共享 ModelRuntime（进程级懒加载一次；ModelRuntime.create 默认离线读 models.json/auth.json） */
export function getModelRuntime(): Promise<ModelRuntime> {
  sharedRuntime ??= ModelRuntime.create()
  return sharedRuntime
}

export interface ResolvedModelSpec {
  model?: Model<any>
  /** 从 "provider/model:thinking" 后缀解析出的思考等级（透传 createAgentSession.thinkingLevel） */
  thinkingLevel?: string
  /** 查询不到等非致命问题的提示（调用方自行决定日志与回退） */
  warning?: string
}

/** 解析模型串；runtime 可注入（测试用），缺省用进程级共享实例 */
export async function resolveModelSpec(spec: string, runtime?: ModelRuntime): Promise<ResolvedModelSpec> {
  let rest = spec.trim()
  let thinkingLevel: string | undefined
  const colon = rest.lastIndexOf(":")
  if (colon > 0) {
    const t = rest.slice(colon + 1)
    if (t) thinkingLevel = t
    rest = rest.slice(0, colon)
  }

  const rt = runtime ?? (await getModelRuntime())
  const slash = rest.indexOf("/")
  let model: Model<any> | undefined
  if (slash > 0) {
    const provider = rest.slice(0, slash)
    const modelId = rest.slice(slash + 1)
    model = rt.getModel(provider, modelId) ?? rt.getModels(provider).find((m) => m.id === modelId)
  } else {
    // 无 provider 前缀：全注册表按 id 兜底查找
    model = rt.getModels().find((m) => m.id === rest)
  }

  if (!model) {
    return { thinkingLevel, warning: `模型 "${spec}" 不在模型注册表中，回退会话默认模型` }
  }
  return { model, thinkingLevel }
}
