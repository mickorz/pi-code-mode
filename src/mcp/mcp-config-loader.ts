/**
 * MCP 配置文件读取（M2）——pi-coding-agent 1.3.0 的 loadMcpConfig 未从包主入口导出，
 * 按 config.d.ts 文档语义实现最小等价读取（JSON 解析 + 项目覆盖合并），供 filterMcpConfig 消费。
 *
 * 官方语义（extensions/mcp/config.d.ts 头注释）：
 *  - 全局：~/.pi/agent/mcp.json；项目（受信时）：<cwd>/.pi/mcp.json；均用 mcpServers shape
 *  - 项目 entry 含 command/url/type（完整定义）→ 替换同名全局 entry
 *  - 项目 entry 不含上述字段 → 仅覆盖全局 entry 的 enabled/exposure/toolExposure（其余保留，含凭证）
 *  - disabled entries 也纳入（enabled:false，供再启用）
 * env 的 ${VAR}/!cmd 展开发生在扩展的 transport 构建层，本读取器原样透传。
 */
import fs from "node:fs"
import path from "node:path"

import type { LoadedMcpConfig, McpServerEntry } from "@earendil-works/pi-coding-agent"

function readMcpJson(file: string, errors: string[]): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(file, "utf8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
    errors.push(`mcp config not an object: ${file}`)
    return null
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code !== "ENOENT") errors.push(`mcp config parse failed: ${file} (${String((e as Error)?.message ?? e)})`)
    return null
  }
}

/** 读取全局 + 项目（受信时）mcp.json 并合并，产出过滤前的 LoadedMcpConfig */
export function readMcpConfigFiles(agentDir: string, cwd: string, projectTrusted: boolean): LoadedMcpConfig {
  const errors: string[] = []
  const globalFile = path.join(agentDir, "mcp.json")
  const projectFile = path.join(cwd, ".pi", "mcp.json")
  const globalDoc = readMcpJson(globalFile, errors)
  const projectDoc = projectTrusted ? readMcpJson(projectFile, errors) : null

  const globalMap = (globalDoc?.mcpServers ?? {}) as Record<string, Record<string, unknown>>
  const projectMap = (projectDoc?.mcpServers ?? {}) as Record<string, Record<string, unknown>>

  const names = [...new Set([...Object.keys(globalMap), ...Object.keys(projectMap)])]
  const servers: McpServerEntry[] = names.map((name) => {
    const g = globalMap[name]
    const p = projectMap[name]
    if (g && p) {
      const isFullDefinition = Boolean(p.command || p.url || p.type)
      if (isFullDefinition) {
        return { name, config: p as unknown as McpServerEntry["config"], source: projectFile, scope: "project" }
      }
      // 项目仅覆盖 enabled/exposure/toolExposure，其余（含凭证）保留全局
      const config = { ...g } as Record<string, unknown>
      if (p.enabled !== undefined) config.enabled = p.enabled
      if (p.exposure !== undefined) config.exposure = p.exposure
      if (p.toolExposure !== undefined) config.toolExposure = p.toolExposure
      return { name, config: config as unknown as McpServerEntry["config"], source: globalFile, scope: "global", override: projectFile }
    }
    if (p) return { name, config: p as unknown as McpServerEntry["config"], source: projectFile, scope: "project" }
    return { name, config: g as unknown as McpServerEntry["config"], source: globalFile, scope: "global" }
  })

  return {
    servers,
    errors,
    autoEnableCodemode: (projectDoc?.autoEnableCodemode as boolean | undefined) ?? (globalDoc?.autoEnableCodemode as boolean | undefined),
    projectConfig: projectTrusted ? projectFile : undefined,
  }
}
