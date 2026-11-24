/**
 * AgentSessionRunner —— Runtime 与 OpenCode 之间的最小注入缝
 *
 * 依赖方向：
 *  src/runtime/（禁止 import opencode 包）
 *   -> AgentSessionRunner 接口（本文件，无任何 OpenCode 依赖）
 *        -> OpenCodeSessionAdapter 实现（src/adapters/）
 *             -> @opencode-ai/plugin 的 client.session.*
 *
 *  测试在接口处注入 fake runner（countingAgent / deferredAgent 模式），
 *  与 Pi 的 53 个 node:test 测试同一套路。
 */

import type { AgentUsage } from "../types/index.js"

/** 传给 Adapter 的单次 agent 调用选项（runtime 组装，脚本不直接可见） */
export interface AgentRunOptions {
  label?: string
  phase?: string
  /** OpenCode agent 名（explore / general / 自定义） */
  agentType?: string
  /** "provider/modelId" 或裸 "modelId" */
  model?: string
  /** JSON Schema 对象；存在时走 OpenCode 原生 format: json_schema */
  schema?: Record<string, unknown>
  /** 本 attempt 的取消信号（run 级 abort 或本 agent 超时触发） */
  signal?: AbortSignal
  /** 会话路由目录（worktree 隔离时指向 worktree 路径，经 query.directory 路由，P1-5） */
  directory?: string
  /** Adapter 从 prompt 响应提取用量后回调 */
  onUsage?: (usage: AgentUsage) => void
  /** Adapter 建完子会话后立即回调（F-20：running 态就能拿到 sessionId 供 TUI 导航） */
  onSessionCreated?: (sessionId: string) => void
  /**
   * 运行中的流式输出（节流后的尾部文本；方案 B）。
   * 仅用于 TUI 展示：Runtime 只把它挂到 AgentRecord.partialOutput，不进 journal/hash。
   */
  onPartial?: (tail: string) => void
  /**
   * Runtime 注入的本 attempt 执行标识（v5：与 Runtime 的 executionId 体系贯通，
   * 格式 runId:callIndex:attempt）；缺省时 Adapter 自造 UUID 兼容旧调用方。脚本不可见。
   */
  executionId?: string
}

/**
 * Adapter 统一执行结果（FR-2，Node Inspector）：
 * text / structured 两分支 + 子会话 ID。
 * 仅在 runtime 内部流转给节点记录与 journal；对 workflow 脚本的 agent() 仍直接返回 value。
 */
export type AgentExecutionResult =
  | { type: "text"; value: string; sessionId: string }
  | { type: "structured"; value: unknown; sessionId: string }

/** 最小 runner 接口：Runtime 只认这个形状 */
export interface AgentSessionRunner {
  run(prompt: string, options?: AgentRunOptions): Promise<AgentExecutionResult>
}
