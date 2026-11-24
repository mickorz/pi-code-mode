/**
 * MCP 策略层（M1，薄）—— Agent 级 MCP 权限过滤
 *
 * 职责边界：只做「默认配置 → 按 Agent 策略过滤 → 产出过滤后 LoadedMcpConfig」的纯函数；
 * 连接生命周期、工具发现、调用执行全部由 pi 内建 MCP 扩展负责（不自建 Manager）。
 *
 * 权限三条铁律（详见 dev-docs/planning/2026-11-17-mcp-integration-执行计划.md 第三节）：
 *  1. Server 授权 ≠ 工具授权：servers 只控制连接；工具默认 hidden，allowTools 显式开放；
 *     配置阶段不知道工具名（连接后动态发现），因此默认拒绝用「server exposure=hidden + 少量覆盖」
 *     的官方范式实现（F12），不枚举全部工具。
 *  2. deny 优先于 allow：由 toolExposure 对象键序结构化保证——
 *     排列 [deny 精确名][allow 精确名][deny 模式][allow 模式]，官方语义
 *     「精确名赢过模式、模式间首个匹配获胜」（getMcpToolExposure，mcp-servers.js:126-136）保证 deny 恒胜。
 *  3. 结构层匹配，永不解析 mcp__ 字符串：匹配在 McpServerEntry 结构上做；
 *     `<server>:<tool>` 规范名只在策略解析时按第一个冒号切分（server 名不含冒号）。
 *
 * 注意（F14）：server 名中 "-" 会映射为 "_" 出现在 mcp__ 工具名中；本模块产出的
 * toolExposure key 用 server 视角裸工具名（pi 原生约定），不受该映射影响。
 */
import type { LoadedMcpConfig, McpExposure, McpServerEntry } from "@earendil-works/pi-coding-agent"
import type { McpPolicy } from "./types.js"

/** 重新导出，保持现有 `from ".../mcp-policy.js"` 引用不断 */
export type { McpPolicy, McpToolCallSummary } from "./types.js"

/** 按 "<server>:<tool>" 切分规范名（第一个冒号；server 名约定不含冒号） */
export function splitToolSpec(spec: string): { server: string; tool: string } | null {
  const idx = spec.indexOf(":")
  if (idx <= 0 || idx === spec.length - 1) return null
  return { server: spec.slice(0, idx), tool: spec.slice(idx + 1) }
}

/** 未声明 servers 白名单时的缺省语义：none=拒绝全部（默认），all=全部 enabled server */
export type DefaultServersMode = "none" | "all"

/**
 * 过滤默认 MCP 配置：按 Agent 策略产出 LoadedMcpConfig（McpExtensionOptions.loadConfig 注入用）。
 * 纯函数：不读文件、不发起连接、不改入参。
 *
 * defaultServers 语义（未写 servers 白名单时）：
 *  - "none"（缺省，M2 子 Agent 场景）：默认拒绝——模型自主探索 + N×M 并发连接成本，需显式声明
 *  - "all"（M4 workflow 直调场景）：默认全部 enabled server——作者在脚本里写死的同步调用，
 *    且池为懒连接（只连实际调用的 server，F16 阻塞面=调用面）；要封锁特定工具用 denyTools
 */
export function filterMcpConfig(
  base: LoadedMcpConfig,
  policy: McpPolicy,
  opts?: { defaultServers?: DefaultServersMode },
): LoadedMcpConfig {
  const defaultMode = opts?.defaultServers ?? "none"
  const errors: string[] = [...base.errors]
  // 总开关关闭 → 空集；未配白名单时按 defaultServers 决定缺省面
  if (!policy.enabled) {
    return { servers: [], errors, autoEnableCodemode: base.autoEnableCodemode, projectConfig: base.projectConfig }
  }
  if (!policy.servers || policy.servers.length === 0) {
    if (defaultMode === "none") {
      return { servers: [], errors, autoEnableCodemode: base.autoEnableCodemode, projectConfig: base.projectConfig }
    }
    // "all"：全部 enabled server（meta.mcp 缺省 / { enabled: true } 均落入）
    const servers = base.servers
      .filter((e) => (e.config as unknown as { enabled?: unknown }).enabled !== false)
      .map((e) => ({ ...e }))
    return { servers, errors, autoEnableCodemode: base.autoEnableCodemode, projectConfig: base.projectConfig }
  }

  const wanted = new Set(policy.servers)
  const matched = base.servers.filter((e) => wanted.has(e.name))
  for (const name of policy.servers) {
    if (!matched.some((e) => e.name === name)) {
      errors.push(`mcp policy: server "${name}" not found in config, skipped`)
    }
  }

  // 工具级授权按 server 分组
  const allowByServer = new Map<string, string[]>()
  for (const spec of policy.allowTools ?? []) {
    const split = splitToolSpec(spec)
    if (!split) {
      errors.push(`mcp policy: invalid allowTools spec "${spec}" (expect "<server>:<tool>")`)
      continue
    }
    if (!wanted.has(split.server)) continue
    const list = allowByServer.get(split.server) ?? []
    list.push(split.tool)
    allowByServer.set(split.server, list)
  }
  const denyByServer = new Map<string, string[]>()
  for (const spec of policy.denyTools ?? []) {
    const split = splitToolSpec(spec)
    if (!split) {
      errors.push(`mcp policy: invalid denyTools spec "${spec}" (expect "<server>:<tool>")`)
      continue
    }
    if (!wanted.has(split.server)) continue
    const list = denyByServer.get(split.server) ?? []
    list.push(split.tool)
    denyByServer.set(split.server, list)
  }

  const servers: McpServerEntry[] = matched.map((entry) => {
    const allows = allowByServer.get(entry.name)
    const denies = denyByServer.get(entry.name) ?? []
    // server 级默认 exposure：策略显式覆盖 > hidden（工具级授权存在时）/ 保留原值（无工具级配置时）
    const serverExposure: McpExposure =
      policy.exposure?.[entry.name] ?? (allows || denies ? "hidden" : entry.config.exposure ?? "codemode")

    // 无任何工具级配置：仅应用 server exposure 覆盖（若策略给了）
    if (!allows && denies.length === 0) {
      if (policy.exposure?.[entry.name] === undefined) return entry
      return { ...entry, config: { ...entry.config, exposure: serverExposure } }
    }

    // 有工具级配置：铁律 1+2 —— 默认 hidden，显式开放；deny 全部先处理（先到先得，同键 deny 恒胜）；
    // 键序 [deny精确名][allow精确名][deny模式][allow模式]（官方语义：精确名赢模式，模式间首个匹配获胜）
    const openExposure: McpExposure = policy.exposure?.[entry.name] ?? "codemode"
    const toolExposure: Record<string, McpExposure> = {}
    const put = (key: string, exposure: McpExposure) => {
      if (!Object.hasOwn(toolExposure, key)) toolExposure[key] = exposure
    }
    for (const t of denies) if (!t.includes("*")) put(t, "hidden") // deny 精确名
    for (const t of allows ?? []) if (!t.includes("*")) put(t, openExposure) // allow 精确名
    for (const t of denies) if (t.includes("*")) put(t, "hidden") // deny 模式（先于 allow 模式，首匹配获胜）
    for (const t of allows ?? []) if (t.includes("*")) put(t, openExposure) // allow 模式

    return { ...entry, config: { ...entry.config, exposure: serverExposure, toolExposure } }
  })

  return { servers, errors, autoEnableCodemode: base.autoEnableCodemode, projectConfig: base.projectConfig }
}
