/**
 * Workflow Runtime 直调 MCP 的受控 Client 池（M4）
 *
 * 设计边界（执行计划第四节）：
 *  - Workflow VM 不直接持有 MCP Client/Node 网络能力——VM 内只见受控注入的 `mcp`/`tools` 对象，
 *    每次调用经本池的权限检查（filterMcpConfig 产出的 exposure 语义）与审计回调。
 *  - 权限：池按 root workflow 的 meta.mcp（McpPolicy）建白名单（默认拒绝）；脚本调用超出
 *    白名单的 server / hidden 工具一律抛错。
 *  - 生命周期：懒连接（首次访问该 server 才连）、run 结束 dispose()（M0-4/F15 教训：必须显式回收）。
 *  - 复用：配置读取复用 readMcpConfigFiles + filterMcpConfig（M1/M2 同一策略链）；
 *    传输用 pi-mcp 的 StdioTransport / StreamableHttpTransport（F10）。
 */
import os from "node:os"
import path from "node:path"

import {
  type LoadedMcpConfig,
  type McpServerEntry,
} from "@earendil-works/pi-coding-agent"
import {
  McpClient,
  StreamableHttpTransport,
  StdioTransport,
  type CallToolResult,
  type Tool,
} from "@earendil-works/pi-mcp"

import type { McpPolicy } from "../engine/types/index.js"
import { readMcpConfigFiles } from "./mcp-config-loader.js"
import { filterMcpConfig } from "./mcp-policy.js"

/** 与 pi 内建 getMcpToolExposure 等价的 exposure 判定（精确名 → 首个命中的模式 → server 默认） */
function toolExposure(entry: McpServerEntry, toolName: string): McpServerEntry["config"]["exposure"] {
  const config = entry.config as unknown as Record<string, unknown>
  const overrides = (config.toolExposure ?? {}) as Record<string, string>
  const exact = overrides[toolName]
  if (exact !== undefined) return exact as McpServerEntry["config"]["exposure"]
  for (const [pattern, exposure] of Object.entries(overrides)) {
    if (pattern.includes("*")) {
      const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`)
      if (re.test(toolName)) return exposure as McpServerEntry["config"]["exposure"]
    }
  }
  return (config.exposure as McpServerEntry["config"]["exposure"] | undefined) ?? "codemode"
}

/** server 名 → mcp namespace 段（F14：pi 约定 "-" → "_"） */
function namespaceOf(server: string): string {
  return server.replace(/-/g, "_")
}

export interface McpClientPoolOptions {
  policy: McpPolicy
  /** 宿主全局配置目录（读 mcp.json），缺省 ~/.pi/agent */
  agentDir?: string
  /** 项目目录（受信时读 .pi/mcp.json），缺省 process.cwd() */
  cwd?: string
  signal?: AbortSignal
  /** 单请求超时毫秒；缺省 60000 */
  timeoutMs?: number
}

interface Connection {
  client: McpClient
  transport: { close(): Promise<void> }
  tools?: Tool[]
}

/** 每个 run 一个池实例：懒连接、权限过滤、run 结束 dispose */
export class McpClientPool {
  private readonly entries: Map<string, McpServerEntry> = new Map()
  private readonly connections: Map<string, Connection> = new Map()
  private readonly toolsCache: Map<string, Tool[]> = new Map()
  private timeoutMs: number
  private readonly signal?: AbortSignal
  private disposed = false

  constructor(options: McpClientPoolOptions) {
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.signal = options.signal
    const agentDir = options.agentDir ?? path.join(os.homedir(), ".pi", "agent")
    const cwd = options.cwd ?? process.cwd()
    const base: LoadedMcpConfig = readMcpConfigFiles(agentDir, cwd, true)
    const filtered = filterMcpConfig(base, options.policy)
    for (const entry of filtered.servers) this.entries.set(entry.name, entry)
  }

  /** 白名单内的 server 名（按策略过滤后） */
  listServers(): string[] {
    return [...this.entries.keys()]
  }

  /**
   * 解析 mcp__<server>__<tool> 形式的全名到白名单内的 server 与裸工具名。
   * server 名中 "-" 以 "_" 出现在工具名（F14），按白名单逐个前缀匹配还原。
   * 未命中（非白名单 server / 未知前缀）返回 null，由调用方抛权限错误。
   */
  resolveQualifiedName(qualified: string): { server: string; entry: McpServerEntry; tool: string } | null {
    for (const [server, entry] of this.entries) {
      const prefix = `mcp__${namespaceOf(server)}__`
      if (qualified.startsWith(prefix)) {
        return { server, entry, tool: qualified.slice(prefix.length) }
      }
    }
    return null
  }

  /** 白名单内 server 的工具清单（tools/list，结果缓存；hidden 工具不返回） */
  async listTools(server: string): Promise<Tool[]> {
    const entry = this.entries.get(server)
    if (!entry) throw new Error(`MCP server "${server}" 不在 workflow 的 mcp 白名单内`)
    const cached = this.toolsCache.get(server)
    if (cached) return cached
    const conn = await this.connect(server)
    const tools = await conn.client.listTools({ signal: this.timeoutSignal(), timeoutMs: this.timeoutMs })
    const visible = tools.filter((t: Tool) => toolExposure(entry, t.name) !== "hidden")
    this.toolsCache.set(server, visible)
    return visible
  }

  /** 调用工具：hidden 工具拒绝（与 pi exposure 语义一致）；返回 CallToolResult 原始结构 */
  async callTool(server: string, toolName: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    const entry = this.entries.get(server)
    if (!entry) throw new Error(`MCP server "${server}" 不在 workflow 的 mcp 白名单内`)
    if (toolExposure(entry, toolName) === "hidden") {
      throw new Error(`MCP 工具 "${server}/${toolName}" 被 mcp 策略拒绝（hidden）`)
    }
    const conn = await this.connect(server)
    return conn.client.callTool(toolName, args ?? {}, { signal: this.timeoutSignal(), timeoutMs: this.timeoutMs })
  }

  /** 关闭全部连接（run 结束时调用；幂等）。stdio 子进程经 transport.close() 回收 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const errors: unknown[] = []
    for (const conn of this.connections.values()) {
      try {
        await conn.client.close()
      } catch (e) {
        errors.push(e)
      }
      try {
        await conn.transport.close()
      } catch (e) {
        errors.push(e)
      }
    }
    this.connections.clear()
    this.toolsCache.clear()
    if (errors.length > 0) {
      console.warn(`[pi-code-mode] MCP 池关闭时出现 ${errors.length} 个非致命错误（已忽略）`)
    }
  }

  private timeoutSignal(): AbortSignal | undefined {
    if (!this.timeoutMs) return this.signal
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const settle = () => clearTimeout(timer)
    this.signal?.addEventListener("abort", () => {
      controller.abort()
      settle()
    }, { once: true })
    controller.signal.addEventListener("abort", settle, { once: true })
    return controller.signal
  }

  private async connect(server: string): Promise<Connection> {
    if (this.disposed) throw new Error("MCP 池已关闭（workflow 已结束）")
    const existing = this.connections.get(server)
    if (existing) return existing
    const entry = this.entries.get(server)
    if (!entry) throw new Error(`MCP server "${server}" 不在 workflow 的 mcp 白名单内`)
    if (this.signal?.aborted) throw new Error(`workflow 已中止，跳过连接 MCP server "${server}"`)

    const client = new McpClient({ name: "pi-code-mode-workflow", version: "0.1.0" })
    const config = entry.config as unknown as Record<string, unknown>
    let transport: { close(): Promise<void> }
    if (config.type === "http" || typeof config.url === "string") {
      transport = new StreamableHttpTransport({
        url: String(config.url),
        headers: (config.headers as Record<string, string> | undefined) ?? {},
        openGetStream: false,
      })
    } else {
      const stdioConfig = config as { command: string; args?: string[]; env?: Record<string, string> }
      transport = new StdioTransport({
        command: String(stdioConfig.command),
        args: stdioConfig.args ?? [],
        env: stdioConfig.env,
        stderr: "pipe",
      })
    }
    await client.connect(transport as never)
    const conn: Connection = { client, transport }
    this.connections.set(server, conn)
    return conn
  }
}

// ── Workflow VM 注入层（官方 codemode 同款调用形态） ──

/** MCP 直调审计记录（server 级；toolName 为 mcp__ 全名） */
export type McpDirectCallRecord = McpToolCallSummaryLike & { server: string; qualifiedName: string }

interface McpToolCallSummaryLike {
  toolName: string
  status: "ok" | "error"
  argsBytes: number
  argsKeys?: string[]
  durationMs?: number
  error?: string
}

export interface McpInvokerOptions {
  /** 池（root 建立的白名单可达面） */
  pool: McpClientPool
  /** 本 invocation 的 server 白名单收敛声明（meta.mcp.servers）；undefined = 拒绝全部 */
  localServers?: string[]
  /** 审计回调（每条调用实时发） */
  onCall?: (record: McpDirectCallRecord) => void
  /** 实际使用 invoker 时触发（call/listTools；纯 MCP workflow 的 toolCount 依据） */
  onTouch?: () => void
}

export interface McpInvoker {
  /** mcp.call(server, tool, args) —— 结果形态对齐官方 codemode：structuredContent 优先，否则文本串；isError/被拒 reject */
  call(server: string, tool: string, args?: Record<string, unknown>): Promise<unknown>
  /** mcp.listTools(server) —— 白名单 server 的可见工具清单（hidden 不返回） */
  listTools(server: string): Promise<Array<{ name: string; description?: string }>>
  /** mcp.listServers() —— 本 invocation 可达的 server 白名单 */
  listServers(): string[]
  /**
   * 构建 tools 对象（官方 prelude 同款：宿主侧预生成普通函数注入，key 为 mcp__<server>__<tool>）。
   * 不用跨边界 Proxy——node:vm contextify 会干扰 Proxy get trap（实测 "is not a function"）。
   * 工具集以首次 listTools 快照为准（MCP server 工具集在连接后视为稳定）。
   */
  buildToolsObject(): Promise<Record<string, (args?: Record<string, unknown>) => Promise<unknown>>>
}

/** 组装注入 workflow VM 的 mcp/tools 对象（每次 invocation 独立；server 面 = 池 ∩ localServers） */
export function makeMcpInvoker(options: McpInvokerOptions): McpInvoker {
  const { pool, onCall } = options
  const local = options.localServers ? new Set(options.localServers) : undefined
  const allowed = pool.listServers().filter((s) => !local || local.has(s))

  const audit = (qualified: string, server: string, startedAt: number, args: unknown, run: () => Promise<CallToolResult>) =>
    (async () => {
      let argsStr = ""
      try {
        argsStr = JSON.stringify(args ?? {})
      } catch {
        argsStr = ""
      }
      try {
        const result = await run()
        onCall?.({
          server,
          qualifiedName: qualified,
          toolName: qualified,
          status: result.isError ? "error" : "ok",
          argsBytes: Buffer.byteLength(argsStr, "utf8"),
          argsKeys: Object.keys(args ?? {}),
          durationMs: Date.now() - startedAt,
        })
        // 官方 codemode 结果形态：structuredContent 优先，否则文本拼接
        if (result.structuredContent !== undefined) return result.structuredContent
        return result.content
          .map((block) => (block.type === "text" ? block.text : JSON.stringify(block)))
          .join("")
      } catch (e) {
        onCall?.({
          server,
          qualifiedName: qualified,
          toolName: qualified,
          status: "error",
          argsBytes: Buffer.byteLength(argsStr, "utf8"),
          argsKeys: Object.keys(args ?? {}),
          durationMs: Date.now() - startedAt,
          error: String((e as Error)?.message ?? e).slice(0, 300),
        })
        throw e
      }
    })()

  const allowedServers = () => allowed.join(", ") || "(无——meta.mcp.servers 未声明或为空)"

  const invoker: McpInvoker = {
    async call(server, tool, args) {
      options.onTouch?.()
      if (!allowed.includes(server)) {
        throw new Error(
          `mcp.call("${server}") 被拒绝：server 不在本 workflow 的 mcp 白名单内。可达 server：${allowedServers()}`,
        )
      }
      return audit(`mcp__${namespaceOf(server)}__${tool}`, server, Date.now(), args, () =>
        pool.callTool(server, tool, args),
      )
    },
    async listTools(server) {
      options.onTouch?.()
      if (!allowed.includes(server)) {
        throw new Error(
          `mcp.listTools("${server}") 被拒绝：server 不在本 workflow 的 mcp 白名单内。可达 server：${allowedServers()}`,
        )
      }
      const tools = await pool.listTools(server)
      return tools.map((t) => ({ name: t.name, description: t.description }))
    },
    listServers() {
      return [...allowed]
    },
    async buildToolsObject() {
      const obj: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {}
      for (const server of allowed) {
        let tools: Array<{ name: string }> = []
        try {
          tools = await invoker.listTools(server)
        } catch (e) {
          console.warn(`[pi-code-mode] MCP server "${server}" 工具枚举失败，已跳过：${String((e as Error)?.message ?? e)}`)
          continue
        }
        for (const tool of tools) {
          const qualified = `mcp__${namespaceOf(server)}__${tool.name}`
          obj[qualified] = (args?: Record<string, unknown>) =>
            audit(qualified, server, Date.now(), args, () => pool.callTool(server, tool.name, args))
        }
      }
      return obj
    },
  }
  return invoker
}
