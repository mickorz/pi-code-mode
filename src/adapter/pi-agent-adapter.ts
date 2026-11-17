/**
 * PiAgentAdapter —— AgentAdapter 契约的 pi SDK 实现
 *
 * 每次子代理调用创建独立的内存态 pi AgentSession：
 *   - SessionManager.inMemory() 不落盘（与 opencode 版子会话内存态一致）
 *   - DefaultResourceLoader({ noExtensions }) 防递归编排（M0 实测宿主扩展零加载）
 *   - SettingsManager.create 继承用户 provider/model 认证
 * usage 直接取 pi 规范化单值（message.usage）；cancel 走 session.abort（M0 实测 13ms 生效）
 *
 * M0 实证依据：dev-docs/progress-result/M0-执行报告.md；spike：dev-examples/m0-spike/spike.ts
 */

import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type LoadedMcpConfig,
} from "@earendil-works/pi-coding-agent"
import os from "node:os"
import path from "node:path"
import type { Model } from "@earendil-works/pi-ai"
import type { McpPolicy, McpToolCallSummary } from "../engine/types/index.js"
import { redactValue, truncateUtf8ByBytes } from "../engine/runtime/agent-result.js"
import { filterMcpConfig } from "../mcp/mcp-policy.js"
import { readMcpConfigFiles } from "../mcp/mcp-config-loader.js"
import type { AgentAdapter, AgentEvent, AgentRequest, AgentResult, ExecutionContext } from "./types.js"
import { validateStructured } from "./structured.js"
import { resolveModelSpec } from "./model-spec.js"

const DEFAULT_AGENT_DIR = path.join(os.homedir(), ".pi", "agent")

/**
 * MCP loadConfig 注入（M2）：读宿主用户/项目 mcp.json 后按 Agent 策略过滤。
 * 注意：pi 1.3.0 的 loadMcpConfig 函数未从包主入口导出，读取由 readMcpConfigFiles 实现
 * （复刻官方 override 语义）；loadConfig 返回值与默认实现走扩展内同一下游（startConnection）。
 * projectTrusted=true：子会话由宿主（已通过项目信任确认）发起，信任决定继承宿主。
 * F16 实证依据：需认证/故障 server 会阻塞同会话其他 server，必须在过滤层挡掉——
 * 默认拒绝由 filterMcpConfig 保证（未列白名单的 server 不会出现在产出配置中）。
 */
function makeMcpLoadConfig(agentDir: string, cwd: string, policy: McpPolicy) {
  return (): LoadedMcpConfig => {
    const base = readMcpConfigFiles(agentDir, cwd, true)
    return filterMcpConfig(base, policy)
  }
}

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
    // M2：policy.mcp.enabled 时显式装配 MCP/Codemode/ToolSearch 三工厂（F4：inline 工厂不受 noExtensions 影响）
    const agentDir = this.agentDir ?? DEFAULT_AGENT_DIR
    const mcpEnabled = policy.mcp?.enabled === true
    const extensionFactories = mcpEnabled
      ? [
          createMcpExtension({ loadConfig: makeMcpLoadConfig(agentDir, cwd, policy.mcp!) }),
          // codemode/tool_search 注册后默认 inactive，由 MCP 扩展按 exposure 自动激活（F5），不双写
          createCodemodeExtension(),
          createToolSearchExtension(),
        ]
      : []
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: policy.noExtensions !== false,
      ...(extensionFactories.length > 0 ? { extensionFactories } : {}),
    })
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

    // F5：MCP 扩展在 session_start 连接 server，prompt 前必须 bindExtensions（M0-1 实证顺序）
    if (mcpEnabled) {
      try {
        await session.bindExtensions({})
      } catch (e) {
        return fail("session", `MCP 扩展绑定失败: ${String((e as Error)?.message ?? e)}`, session.sessionId)
      }
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

    try {
      // schema 路径（R3 M2）：JSON 输出要求 + typebox 校验 + 修复循环（校验失败把错误清单附回 prompt，最多 2 轮）
      const MAX_FIX_ROUNDS = 2
      let finalPrompt = request.prompt
      if (request.outputSchema) {
        finalPrompt += `\n\n[输出要求] 只输出一个 JSON 对象（符合给定 schema 语义），不要输出任何其他内容。`
      }

      let text = ""
      let usage: { inputTokens: number; outputTokens: number } | undefined
      // M2 v5 P0：MCP 工具调用事件侧实时采集（start 记摘要，end 组装安全摘要后经 record 事件上报）
      const mcpInflight = new Map<
        string,
        { toolName: string; argsBytes: number; argsKeys: string[]; parentToolCallId?: string }
      >()
      const emitMcpSummary = (s: McpToolCallSummary) => {
        emit({ type: "record", executionId: ctx.executionId, record: { kind: "mcp-tool-call", ...s } })
      }
      // v4：attempt 终结时未配对的 start（工具还在跑就被取消/超时）记为 error 摘要，不丢已发生调用
      const flushUnpaired = () => {
        for (const [, started] of mcpInflight) {
          emitMcpSummary({
            toolName: started.toolName,
            status: "error",
            argsBytes: started.argsBytes,
            argsKeys: started.argsKeys,
            error: "cancelled or interrupted before completion",
            parentToolCallId: started.parentToolCallId,
          })
        }
        mcpInflight.clear()
      }
      const unsub = session.subscribe((e: any) => {
        if (e.type === "tool_execution_start" && typeof e.toolName === "string" && e.toolName.startsWith("mcp__")) {
          const args = e.args
          let argsStr = ""
          try {
            argsStr = JSON.stringify(args ?? {})
          } catch {
            argsStr = ""
          }
          mcpInflight.set(String(e.toolCallId), {
            toolName: e.toolName,
            argsBytes: Buffer.byteLength(argsStr, "utf8"),
            argsKeys: Object.keys(args ?? {}),
            parentToolCallId: typeof e.parentToolCallId === "string" ? e.parentToolCallId : undefined,
          })
        }
        if (e.type === "tool_execution_end" && mcpInflight.has(String(e.toolCallId))) {
          const started = mcpInflight.get(String(e.toolCallId))!
          mcpInflight.delete(String(e.toolCallId))
          const isError = e.isError === true
          emitMcpSummary({
            toolName: started.toolName,
            status: isError ? "error" : "ok",
            argsBytes: started.argsBytes,
            argsKeys: started.argsKeys,
            durationMs: typeof e.durationMs === "number" ? e.durationMs : undefined,
            error: isError
              ? truncateUtf8ByBytes(String(redactValue(String(JSON.stringify(e.result ?? "")))), 200)
              : undefined,
            toolCallId: typeof e.toolCallId === "string" ? e.toolCallId : undefined,
            parentToolCallId: started.parentToolCallId,
          })
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
        flushUnpaired()

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
      flushUnpaired()

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
