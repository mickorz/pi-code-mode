/**
 * MCP 契约类型（纯数据，不依赖 pi SDK）。
 *
 * 归属：mcp 包（L1 基础设施）。engine 通过本文件获取 MCP 策略/审计类型，
 * 避免 mcp 反向依赖 engine（分层规则见 tests/contract/layer-guard.test.ts）。
 */
// 注意：本契约文件刻意不依赖 pi SDK（engine 也要引用它）；
// 与 pi 的 McpExposure 保持结构等价，由 mcp-policy.ts 在边界处对接。
type ExposureName = "codemode" | "deferred" | "direct" | "hidden"

/** Agent 级 MCP 权限策略（纯数据；实现见 mcp-policy.ts 的 filterMcpConfig） */
export interface McpPolicy {
  /** 总开关；false 时该 Agent 不装配任何 MCP 能力 */
  enabled: boolean
  /** server 白名单；undefined = 拒绝全部（默认拒绝原则，M0-2A 实证：未授权 server 零连接） */
  servers?: string[]
  /** 工具白名单，规范名 "<server>:<tool>"，支持 "<server>:*" / "<server>:get_*"；未命中者 hidden */
  allowTools?: string[]
  /** 工具黑名单，规范名同上；优先级高于 allowTools 与 server exposure（F12 官方匹配语义保证） */
  denyTools?: string[]
  /** per-server exposure 覆盖（pi 原生语义）；缺省时开放工具按 codemode 处理 */
  exposure?: Record<string, ExposureName>
}

/** MCP 工具调用安全摘要（M2 审计；不存完整参数与返回值，v3 P1-1） */
export interface McpToolCallSummary {
  /** mcp__<server>__<tool> 全名（F14：server 名中 - 已替换为 _） */
  toolName: string
  /** 所属 server 名（M4 直调审计用） */
  server?: string
  status: "ok" | "error"
  /** 参数字节量（不存参数内容） */
  argsBytes: number
  /** 脱敏后的参数键名列表（REDACT_KEY 命中键替换后仍列出键名） */
  argsKeys?: string[]
  durationMs?: number
  /** 错误摘要（脱敏限长后） */
  error?: string
  /** pi 内部调用 id（start/end 事件配对） */
  toolCallId?: string
  /** codemode 脚本内调用时的父调用 id（F18：可归因到脚本调用） */
  parentToolCallId?: string
}
