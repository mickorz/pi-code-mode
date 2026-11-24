/**
 * 探测：宿主真实 mcp.json + 我们的 filterMcpConfig，经 pi MCP 扩展真实连接后枚举工具名
 * （F14：server 名中 "-" 在 mcp__ 前缀名中替换为 "_"；policy 规范名仍用 server 原名）
 * 无模型：bindExtensions 后轮询 getAllTools
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"

import { readMcpConfigFiles } from "../../../packages/mcp/src/mcp-config-loader.js"
import { filterMcpConfig } from "../../../packages/mcp/src/mcp-policy.js"

const HOST = process.env.PI_CODING_AGENT_DIR_ORIGINAL ?? path.join(os.homedir(), ".pi", "agent")
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-agent-"))
for (const f of ["auth.json", "models.json"]) {
  const src = path.join(HOST, f)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f))
}
const st = JSON.parse(fs.readFileSync(path.join(HOST, "settings.json"), "utf8"))
delete st.packages
fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(st, null, 2))
fs.copyFileSync(path.join(HOST, "mcp.json"), path.join(dir, "mcp.json"))
process.env.PI_CODING_AGENT_DIR = dir

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "probe-cwd-"))
const t0 = Date.now()
const base = readMcpConfigFiles(dir, cwd, true)
console.log(`[t+${Date.now() - t0}ms] 配置读取：servers=${base.servers.map((s) => s.name).join(",")} errors=${JSON.stringify(base.errors)}`)

const policy = {
  enabled: true,
  servers: ["web-reader", "zread", "web-search-prime"],
}
const filtered = filterMcpConfig(base, policy)
console.log(`过滤后：${filtered.servers.map((s) => s.name).join(",")}`)

const loader = new DefaultResourceLoader({
  cwd,
  agentDir: dir,
  noExtensions: true,
  extensionFactories: [
    createMcpExtension({ loadConfig: () => filtered }),
    createCodemodeExtension(),
    createToolSearchExtension(),
  ],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
})
await loader.reload()
const sm = SettingsManager.create(cwd)
sm.applyOverrides({ defaultTools: ["+codemode", "+tool_search"] })
const { session } = await createAgentSession({
  cwd,
  agentDir: dir,
  sessionManager: SessionManager.inMemory(),
  settingsManager: sm,
  resourceLoader: loader,
})
await session.bindExtensions({})

// 轮询等工具注册
let all: Array<{ name: string; exposure?: string }> = []
for (let i = 0; i < 60; i++) {
  all = session.getAllTools() as Array<{ name: string; exposure?: string }>
  if (all.filter((t) => t.name.startsWith("mcp__")).length > 0 || i === 59) break
  await new Promise((r) => setTimeout(r, 500))
}
console.log(`[t+${Date.now() - t0}ms] 枚举完成`)
for (const t of all.filter((t) => t.name.startsWith("mcp__"))) {
  console.log(`  ${t.name}  exposure=${t.exposure}`)
}
session.dispose()
process.exit(0)
