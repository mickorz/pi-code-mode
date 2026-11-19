/**
 * PiAgentAdapter —— AgentAdapter 契约的 pi SDK 实现
 *
 * 每次子代理调用创建独立的内存态 pi AgentSession：
 *   - SessionManager.inMemory() 不落盘（与 opencode 版子会话内存态一致）
 *   - DefaultResourceLoader({ noExtensions }) 防递归编排（M0 实测宿主扩展零加载）
 *   - SettingsManager.create 继承用户 provider/model 认证
 * usage 直接取 pi 规范化单值（message.usage）；cancel 走 session.abort（M0 实测 13ms 生效）
 *
 * 流式输出（方案 B）：订阅 `message_update` 的 `text_delta`，经有界尾部缓冲 + 500ms 节流后
 * 以 `partial` 事件上抛给 Runtime（仅展示用；不进 journal、不参与 hash）。
 *
 * M0 实证依据：dev-docs/progress-result/M0-执行报告.md；spike：dev-examples/m0-spike/spike.ts
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent"
import os from "node:os"
import path from "node:path"
import type { Model } from "@earendil-works/pi-ai"
import type { AgentAdapter, AgentEvent, AgentRequest, AgentResult, ExecutionContext } from "./types.js"
import { validateStructured } from "./structured.js"
import { resolveModelSpec } from "./model-spec.js"
import { createPartialBuffer } from "./partial-buffer.js"

const DEFAULT_AGENT_DIR = path.join(os.homedir(), ".pi", "agent")

export interface PiAgentAdapterOptions {
  /** pi 全局配置目录，默认 ~/.pi/agent */
  agentDir?: string
  /** 会话工作目录，默认 process.cwd()（worktree 隔离时由 Engine 传入 worktree 路径） */
  defaultCwd?: string
}

/** 剥掉 markdown 代码围栏后尝试 JSON.parse（P0 基础结构化透传） */
function parseStructured(raw: string): unknown {
  const stripped = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim()
  return JSON.parse(stripped)
}

export class PiAgentAdapter implements AgentAdapter {
  private readonly agentDir?: string
  private readonly defaultCwd?: string
  /** executionId -> 在途会话（cancel 路由） */
  private readonly inflight = new Map<string, AgentSession>()

  constructor(options: PiAgentAdapterOptions = {}) {
    this.agentDir = options.agentDir
    this.defaultCwd = options.defaultCwd
  }

  async execute(request: AgentRequest, ctx: ExecutionContext): Promise<AgentResult> {
    const cwd = request.cwd ?? this.defaultCwd ?? process.cwd()
    const policy = request.tools ?? {}
    const emit = (event: AgentEvent) => ctx.onEvent?.(event)

    // noExtensions 默认 true：子会话不加载宿主扩展，递归编排通道关闭（M0 recursive-guard PASS）
    // 注：子 Agent 不再装配 MCP（2026-11-18 用户决策：workflow 直调为唯一 MCP 通道），见 workflow-runtime 的 mcp 池
    const agentDir = this.agentDir ?? DEFAULT_AGENT_DIR
    const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: policy.noExtensions !== false })
    await loader.reload()

    let session: AgentSession
    try {
      // tier/model 指定（P2 池化前置修复）：解析 provider/model[:thinking] -> Model，
      // 查询不到回退会话默认模型（与 P1-3 回退语义一致）
      let sessionModel: Model<any> | undefined
      let thinkingLevel: string | undefined
      if (request.model) {
        const resolved = await resolveModelSpec(request.model)
        sessionModel = resolved.model
        thinkingLevel = resolved.thinkingLevel
        if (resolved.warning) console.warn(`[pi-code-mode] ${resolved.warning}`)
      }
      const created = await createAgentSession({
        cwd,
        agentDir: this.agentDir,
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.create(cwd, agentDir),
        resourceLoader: loader,
        ...(sessionModel ? { model: sessionModel } : {}),
        ...(thinkingLevel ? { thinkingLevel: thinkingLevel as never } : {}),
        ...(request.tools?.allowTools ? { tools: request.tools.allowTools } : {}),
        ...(policy.excludeTools ? { excludeTools: policy.excludeTools } : {}),
      })
      session = created.session
    } catch (e) {
      return fail("session", `子会话创建失败: ${String((e as Error)?.message ?? e)}`)
    }

    this.inflight.set(ctx.executionId, session)
    emit({ type: "session-created", executionId: ctx.executionId, sessionId: session.sessionId })

    // 取消通道：Engine 的 attempt signal / cancel() 都落到 session.abort（M0: 13ms 生效）
    let cancelled = false
    const onAbort = () => {
      cancelled = true
      void session.abort()
    }
    if (request.signal) {
      if (request.signal.aborted) onAbort()
      else request.signal.addEventListener("abort", onAbort, { once: true })
    }

    // 流式尾部缓冲：在 try 之外声明，finally 里要 flush/dispose
    const partialBuffer = createPartialBuffer({
      maxBytes: 8 * 1024,
      throttleMs: 500,
      onFlush: (tail) => {
        if (cancelled || request.signal?.aborted) return
        emit({ type: "partial", executionId: ctx.executionId, text: tail })
      },
    })

    try {
      // schema 路径（R3 M2）：JSON 输出要求 + typebox 校验 + 修复循环（校验失败把错误清单附回 prompt，最多 2 轮）
      const MAX_FIX_ROUNDS = 2
      let finalPrompt = request.prompt
      if (request.outputSchema) {
        finalPrompt += `\n\n[输出要求] 只输出一个 JSON 对象（符合给定 schema 语义），不要输出任何其他内容。`
      }

      let text = ""
      let usage: { inputTokens: number; outputTokens: number } | undefined
      const unsub = session.subscribe((e: any) => {
        // 只取助手文本增量（thinking/toolcall 分片不上抛，避免噪声）
        if (e.type === "message_update") {
          const ev = e.assistantMessageEvent
          if (ev?.type === "text_delta" && typeof ev.delta === "string") partialBuffer.push(ev.delta)
          return
        }
        if (e.type === "message_end" && e.message?.role === "assistant") {
          for (const c of e.message.content ?? []) {
            if (c.type === "text") text += c.text
          }
          // pi 规范化 usage 单值（M0 实证：无 step-finish 覆盖问题）；部分取消可能缺失，按契约缺省
          // 多轮 prompt 下取累计值（usage 是消息级字段，修复轮只增不减）
          const u = e.message.usage
          if (u) usage = { inputTokens: u.input ?? 0, outputTokens: u.output ?? 0 }
        }
      })

      const t0 = Date.now()
      await session.prompt(finalPrompt)

      // 修复循环：校验失败时把错误清单附回 prompt 重试（订阅保持开启以收集修复轮文本）
      if (request.outputSchema) {
        let validation = validateStructured(text, request.outputSchema)
        let round = 0
        while (!validation.ok && round < MAX_FIX_ROUNDS && !cancelled && !request.signal?.aborted) {
          round += 1
          text = ""
          const fixPrompt =
            `你上次的输出不符合 schema 要求，错误清单:\n${(validation.errors ?? []).map((m: string, i: number) => `${i + 1}. ${m}`).join("\n")}\n\n请只输出修正后的 JSON 对象，不要任何解释文字。`
          await session.prompt(fixPrompt)
          validation = validateStructured(text, request.outputSchema)
        }
        unsub()

        if (cancelled || request.signal?.aborted) {
          return { status: "cancelled", output: { type: "text", value: "" }, sessionId: session.sessionId }
        }
        if (validation.ok) {
          return { status: "ok", output: { type: "structured", value: validation.value }, usage, sessionId: session.sessionId }
        }
        return {
          status: "error",
          output: { type: "text", value: text },
          usage,
          sessionId: session.sessionId,
          error: { kind: "schema", message: `结构化输出校验失败（修复 ${round} 轮后仍不达标）: ${(validation.errors ?? []).join("; ")}` },
        }
      }

      unsub()

      if (cancelled) {
        return { status: "cancelled", output: { type: "text", value: "" }, sessionId: session.sessionId }
      }
      if (request.signal?.aborted) {
        return { status: "cancelled", output: { type: "text", value: "" }, sessionId: session.sessionId }
      }

      emit({
        type: "record",
        executionId: ctx.executionId,
        record: { sessionId: session.sessionId, durationMs: Date.now() - t0, textPreview: text.slice(0, 200) },
      })

      return {
        status: "ok",
        output: { type: "text", value: text },
        usage,
        sessionId: session.sessionId,
      }
    } catch (e) {
      // pi 侧 abort 后 prompt 的异常形态：cancelled 优先
      if (cancelled || request.signal?.aborted) {
        return { status: "cancelled", output: { type: "text", value: "" }, sessionId: session.sessionId }
      }
      return fail("unknown", String((e as Error)?.message ?? e), session.sessionId)
    } finally {
      // 终态前把最后一段增量冲出去（节流窗口内的残余），随后停表
      partialBuffer.flush()
      partialBuffer.dispose()
      this.inflight.delete(ctx.executionId)
    }
  }

  /** 幂等；未知 id 静默成功（契约 §2） */
  async cancel(executionId: string): Promise<void> {
    const session = this.inflight.get(executionId)
    if (session) await session.abort()
  }
}

function fail(kind: NonNullable<AgentResult["error"]>["kind"], message: string, sessionId = ""): AgentResult {
  return {
    status: "error",
    output: { type: "text", value: "" },
    sessionId,
    error: { kind, message },
  }
}
