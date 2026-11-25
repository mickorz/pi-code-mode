/**
 * PermitStore —— 双阶段授权凭证（M0.1 冻结契约的正式实现）
 *
 * 工程原则（执行计划 v3）：任何安全控制都不能仅依赖 Agent Framework 的事件回调成功
 * 执行；真正执行外部副作用的最后一层必须再次验证授权。
 *
 * 落地：tool_call handler（policy-extension）裁决 allow 后签发一次性 Permit；
 * Tool.execute 在触碰 FileService / CommandExecutor 之前必须消费 Permit。
 * M0.1 实证：handler 返回错误形态时 SDK 静默放行（entered=1），无 Permit 的
 * execute 拒绝真实执行（executed=0）。
 *
 * 隔离规则：一个 AgentSession 一个 PermitStore 实例（PiAgentAdapter 每次 execute
 * 新建），禁止全局共享 Map。
 */

import { createHash } from "node:crypto"

export interface ToolPermit {
  toolCallId: string
  toolName: string
  /** SHA-256(稳定序列化参数) 前 16 位：防 handler 改 input 后不重校验（SDK 契约） */
  paramsDigest: string
  issuedAt: number
  expiresAt: number
}

/** 缺省 60s：一次工具调用从授权到执行的窗口上限 */
export const PERMIT_TTL_MS = 60_000

/** 参数稳定摘要：键序无关（排序后序列化），任何嵌套层级均可哈希 */
export function paramsDigest(params: unknown): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, v]) => [k, stable(v)]),
      )
    }
    return value
  }
  return createHash("sha256").update(JSON.stringify(stable(params))).digest("hex").slice(0, 16)
}

export class PermitStore {
  private readonly permits = new Map<string, ToolPermit>()

  /** allow 裁决后签发（policy-extension 调用）；同 toolCallId 重复签发覆盖 */
  issue(toolCallId: string, toolName: string, params: unknown): ToolPermit {
    const now = Date.now()
    const permit: ToolPermit = {
      toolCallId,
      toolName,
      paramsDigest: paramsDigest(params),
      issuedAt: now,
      expiresAt: now + PERMIT_TTL_MS,
    }
    this.permits.set(toolCallId, permit)
    return permit
  }

  /**
   * 一次性消费（Tool.execute 调用）：按 toolCallId 查找 -> 工具名 -> 参数摘要 -> 过期
   * -> 删除 -> 放行。任一失败 fail-closed 返回 false，不暴露失败原因给模型以外的层。
   */
  consume(toolCallId: string, toolName: string, params: unknown): boolean {
    const p = this.permits.get(toolCallId)
    if (
      !p ||
      p.toolName !== toolName ||
      p.paramsDigest !== paramsDigest(params) ||
      p.expiresAt < Date.now()
    ) {
      return false
    }
    this.permits.delete(toolCallId)
    return true
  }

  /** 会话收尾清理（dispose 时调用；未消费 Permit 自然过期失效） */
  clear(): void {
    this.permits.clear()
  }

  /** 在途数量（观测用） */
  get size(): number {
    return this.permits.size
  }
}
