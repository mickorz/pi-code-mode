/**
 * 契约桥接器：AgentAdapter（契约） -> AgentSessionRunner（Engine 缝）
 *
 * Engine（engine/runtime）只认 session-runner.ts 的 AgentSessionRunner：
 *   run(prompt, options): Promise<AgentExecutionResult>，错误一律 throw，
 *   abort 归类靠消息命中 /\babort(ed)?\b/i（engine/runtime/errors.ts wrapError）。
 * 本桥接器负责契约语义转换，runtime 主文件零修改：
 *   - AgentRunOptions -> AgentRequest（model/directory/schema/signal 一一对应）
 *   - AgentResult(ok) -> AgentExecutionResult（text/structured）
 *   - 非 ok status -> throw（cancelled/timeout 的 message 含 abort，命中 WORKFLOW_ABORTED）
 *   - onSessionCreated / onUsage -> execute 返回后回调
 */

import { randomUUID } from "node:crypto"
import type { AgentRunOptions, AgentSessionRunner, AgentExecutionResult } from "../../engine/src/agent/session-runner.js"
import type { AgentUsage } from "../../engine/src/types/index.js"
import type { AgentAdapter, AgentRequest, ExecutionContext, AgentResult } from "./types.js"
/** 把契约 status/error 转换为 Engine 可分类的 throw（runtime wrapError 依赖消息匹配） */
function throwForStatus(result: AgentResult): never {
  if (result.status === "cancelled") {
    throw new AbortedError("agent execution aborted (cancelled)")
  }
  if (result.status === "timeout") {
    throw new AbortedError("agent execution aborted (timeout)")
  }
  const kind = result.error?.kind ?? "unknown"
  const message = result.error?.message ?? `agent failed (${kind})`
  const err = new Error(`[${kind}] ${message}`)
  ;(err as { kind?: string }).kind = kind
  throw err
}

/** 名称与消息双重命中 wrapError 的 AbortError 分支 */
class AbortedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AbortError"
  }
}

/** 契约 usage -> Engine AgentUsage */
function toUsage(usage: NonNullable<AgentResult["usage"]>): AgentUsage {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    total: usage.inputTokens + usage.outputTokens,
    cost: 0,
  }
}

export function agentAdapterToRunner(adapter: AgentAdapter): AgentSessionRunner {
  return {
    async run(prompt: string, options?: AgentRunOptions): Promise<AgentExecutionResult> {
      // v5 P0：executionId 由 Runtime 注入（runId:callIndex:attempt，与 Runtime 收集缓冲同 ID 体系）；
      // 缺省 fallback 自造 UUID 兼容旧调用方
      const executionId = options?.executionId ?? randomUUID()
      const request: AgentRequest = {
        prompt,
        model: options?.model,
        cwd: options?.directory,
        outputSchema: options?.schema,
        signal: options?.signal,
      }
      const ctx: ExecutionContext = {
        executionId,
        // AgentRunOptions 无 runId 字段（runtime 零修改原则）；Adapter 日志关联以 executionId 为准
        runId: "",
        phase: options?.phase,
      }
      // F-20 对齐：Adapter 一建会话就回调 sessionId（经由 onEvent，见各 Adapter 实现）
      if (options?.onSessionCreated) {
        const cb = options.onSessionCreated
        const prev = ctx.onEvent
        ctx.onEvent = (event) => {
          prev?.(event)
          if (event.type === "session-created") cb(event.sessionId)
        }
      }
      // 方案 B：流式尾部快照透传给 Runtime（仅展示；不落盘、不进 hash）
      if (options?.onPartial) {
        const cb = options.onPartial
        const prev = ctx.onEvent
        ctx.onEvent = (event) => {
          prev?.(event)
          if (event.type === "partial") cb(event.text)
        }
      }

      const result = await adapter.execute(request, ctx)

      if (result.usage) options?.onUsage?.(toUsage(result.usage))
      if (result.status !== "ok") throwForStatus(result)

      return result.output.type === "structured"
        ? { type: "structured", value: result.output.value, sessionId: result.sessionId }
        : { type: "text", value: result.output.value as string, sessionId: result.sessionId }
    },
  }
}

/** 组合多个回调（契约 onEvent 链） */
export function chainOnEvent(ctx: ExecutionContext, extra: NonNullable<ExecutionContext["onEvent"]>): ExecutionContext {
  const prev = ctx.onEvent
  return { ...ctx, onEvent: prev ? (e) => (prev(e), extra(e)) : extra }
}
