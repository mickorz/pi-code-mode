/**
 * AgentAdapter 契约类型 —— Engine 与 Pi Session Adapter 的唯一接缝
 *
 * 对应契约文档：dev-docs/design/adapter-contract.md（v1.0）
 * Engine 侧实际依赖的缝是 engine/agent/session-runner.ts 的 AgentSessionRunner，
 * 由 agent-adapter.ts 的 agentAdapterToRunner() 做契约桥接；本文件是契约的标准定义。
 */

/** 工具策略：excludeTools 支持通配符（pi SDK 原生）；noExtensions 默认 true 防递归。
 *  注：子 Agent 不再做 MCP 装配（2026-11-18 用户决策：workflow 直调为唯一 MCP 通道），MCP 走 workflow-runtime 的 mcp 池 */
export type ToolPolicy = {
  excludeTools?: string[]
  noExtensions?: boolean
  allowTools?: string[]
}

export interface AgentRequest {
  prompt: string
  /** provider/modelId 或 tier 解析后的最终模型串 */
  model?: string
  /** worktree 隔离时为 worktree 路径；隔离可达性由 Engine 的 prompt 注入保证 */
  cwd?: string
  tools?: ToolPolicy
  timeoutMs?: number
  signal?: AbortSignal
  /** JSON Schema；P0/M1 仅基础结构化透传（prompt 要求 + 本地解析），修复循环属 M2 */
  outputSchema?: object
}

export interface ExecutionContext {
  /** Engine 生成的全局唯一执行标识；取消路由与日志关联的唯一键，Adapter 只消费不自造 */
  executionId: string
  runId: string
  phase?: string
  /** 流式/进度事件通道：全量推送，不做增量 diff；终态以 execute 的 resolve 值为准 */
  onEvent?: (event: AgentEvent) => void
}

export type ErrorKind =
  | "aborted" // 取消（run/scope/attempt 任一级 signal）
  | "timeout" // attempt 超时
  | "model" // 模型/Provider 拒绝（限流、余额、内容策略）
  | "session" // 会话创建/生命周期失败
  | "schema" // 结构化输出校验失败（M2 修复循环前的重试依据）
  | "unknown" // 未归类；Engine 按 recoverable 处理（沿用 opencode 默认）

export interface AgentResult {
  status: "ok" | "error" | "cancelled" | "timeout"
  output: { type: "text" | "structured"; value: unknown }
  /** 非 ok 终态允许缺省；缺省即未知，消费方禁止按 0 参与统计 */
  usage?: { inputTokens: number; outputTokens: number }
  sessionId: string
  error?: { kind: ErrorKind; message: string }
}

export type AgentEvent =
  | { type: "session-created"; executionId: string; sessionId: string }
  /** 流式输出尾部快照（节流后推送；仅展示用，绝不落盘/不参与 hash） */
  | { type: "partial"; executionId: string; text: string }
  | { type: "attempt"; executionId: string; attempt: number }
  | { type: "record"; executionId: string; record: Record<string, unknown> }

/** Adapter 实现本接口；Engine 经 agentAdapterToRunner() 消费 */
export interface AgentAdapter {
  /** 执行一次子代理调用：创建会话、注入 prompt、等待终态 */
  execute(request: AgentRequest, ctx: ExecutionContext): Promise<AgentResult>
  /** 按 executionId 取消在途执行；幂等，未知 id 静默成功 */
  cancel(executionId: string): Promise<void>
}
