/**
 * M4 契约测试：workflow 直调 MCP（官方 code-mode 同款调用形态）
 * 经 runWorkflow 完整链路（meta.mcp 声明 → VM 注入 mcp/tools → 受控 client 池 → fixture server），
 * 无模型依赖（fake runner 不参与，纯 MCP workflow 合法——toolCount 语义）。
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { runWorkflow } from "../../packages/engine/src/runtime/workflow-runtime.js"
import type { McpToolCallSummary } from "../../packages/engine/src/types/index.js"

const FIXTURE_SERVER = path.join(import.meta.dirname, "..", "fixtures", "echo-mcp-server.mjs")

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 临时 agentDir：只放 fixture 专用 mcp.json（不读宿主配置） */
function prepareAgentDir(): string {
  const dir = tmpDir("mcp4-agent-")
  fs.writeFileSync(
    path.join(dir, "mcp.json"),
    JSON.stringify({ mcpServers: { fix: { type: "stdio", command: process.execPath, args: [FIXTURE_SERVER] } } }),
    "utf8",
  )
  return dir
}

async function run(script: string, runId: string, onMcpCall?: (r: McpToolCallSummary & { server: string }) => void) {
  const dir = tmpDir("mcp4-cwd-")
  return runWorkflow(script, {
    runId,
    agent: { async run() { throw new Error("不应触发子 agent") }, async cancel() {} },
    cwd: dir,
    agentDir: prepareAgentDir(),
    concurrency: 1,
    onMcpCall,
  })
}

test("M4：mcp.call 直调 fixture server 成功（structuredContent/文本形态）", async () => {
  const script = `export const meta = { name: 'm4_call', mcp: { enabled: true, servers: ['fix'], allowTools: ['fix:*'] } }
const r = await mcp.call('fix', 'echo', { text: 'hello-direct' })
return r`
  const result = await run(script, "m4-1")
  assert.equal(String(result.result), "hello-direct")
})

test("M4：tools.mcp__fix__echo proxy 官方同款调用成功", async () => {
  const script = `export const meta = { name: 'm4_proxy', mcp: { enabled: true, servers: ['fix'], allowTools: ['fix:*'] } }
const r = await tools.mcp__fix__echo({ text: 'proxy-ok' })
return r`
  const result = await run(script, "m4-2")
  assert.equal(String(result.result), "proxy-ok")
})

test("M4：mcp.listTools 与 mcp.listServers", async () => {
  const script = `export const meta = { name: 'm4_list', mcp: { enabled: true, servers: ['fix'], allowTools: ['fix:echo'] } }
const servers = mcp.listServers()
const tools = await mcp.listTools('fix')
return { servers, names: tools.map((t) => t.name).sort() }`
  const result = await run(script, "m4-3")
  const out = result.result as { servers: string[]; names: string[] }
  assert.deepEqual(out.servers, ["fix"])
  // allowTools 只放开 echo → hidden 过滤后仅 echo 可见（F12/F13：hidden 不进清单）
  assert.deepEqual(out.names, ["echo"])
})

test("M4：未声明 meta.mcp → 默认全量可用（宿主全部 enabled server，agentDir 隔离后即 fixture）", async () => {
  const script = `export const meta = { name: 'm4_none' }
const r = await mcp.call('fix', 'echo', { text: 'open-by-default' })
return r`
  const result = await run(script, "m4-4")
  assert.equal(String(result.result), "open-by-default")
})

test("M4：meta.mcp 显式 enabled:false → 拒绝桩（显式禁用语义）", async () => {
  const script = `export const meta = { name: 'm4_disabled', mcp: { enabled: false } }
const r = await mcp.call('fix', 'echo', {})
return r`
  await assert.rejects(run(script, "m4-4b"), /显式声明了 enabled: false/)
})

test("M4：denyTools → hidden 拒绝（调用抛策略错误）", async () => {
  const script = `export const meta = { name: 'm4_deny', mcp: { enabled: true, servers: ['fix'], allowTools: ['fix:*'], denyTools: ['fix:echo'] } }
const r = await mcp.call('fix', 'echo', {})
return r`
  await assert.rejects(run(script, "m4-5"), /被 mcp 策略拒绝/)
})

test("M4：白名单外 server → 拒绝（默认拒绝原则）", async () => {
  const script = `export const meta = { name: 'm4_other', mcp: { enabled: true, servers: ['fix'] } }
const r = await mcp.call('ghost', 'echo', {})
return r`
  await assert.rejects(run(script, "m4-6"), /不在本 workflow 的 mcp 可达面内/)
})

test("M4：tools proxy 访问白名单外前缀 → TypeError（枚举走 mcp.listTools）", async () => {
  const script = `export const meta = { name: 'm4_proxy_deny', mcp: { enabled: true, servers: ['fix'] } }
const r = await tools.mcp__ghost__echo({})
return r`
  await assert.rejects(
    run(script, "m4-7"),
    /tools\.mcp__ghost__echo 不存在或不在本 workflow 的 mcp 可达面内.*可达 server：fix/,
  )
  // 说明：tools 为沙箱内 Proxy 按需解析（调用时才校验可达面），未知名报含可达列表的策略错误；
  // 枚举工具用 mcp.listTools(server)
})

test("M4：非 mcp 前缀的 tools 访问 → TypeError（bash 走 runTool）", async () => {
  const script = `export const meta = { name: 'm4_nonmcp', mcp: { enabled: true, servers: ['fix'] } }
const r = await tools.bash({ command: 'echo x' })
return r`
  await assert.rejects(run(script, "m4-8"), /tools 只提供 MCP 工具.*runTool/)
})

test("M4：onMcpCall 审计回调收到每条调用的安全摘要", async () => {
  const records: Array<McpToolCallSummary & { server: string }> = []
  const script = `export const meta = { name: 'm4_audit', mcp: { enabled: true, servers: ['fix'], allowTools: ['fix:*'] } }
await mcp.call('fix', 'echo', { text: 'a', secret_token: 'should-not-leak' })
await tools.mcp__fix__add({ a: 1, b: 2 })
return 'done'`
  await run(script, "m4-9", (r) => records.push(r))
  assert.equal(records.length, 2)
  assert.deepEqual(
    records.map((r) => r.toolName).sort(),
    ["mcp__fix__add", "mcp__fix__echo"],
  )
  for (const r of records) {
    assert.equal(r.status, "ok")
    assert.equal(typeof r.durationMs, "number")
    assert.ok(r.argsKeys!.includes("text") || r.argsKeys!.includes("a"))
    assert.ok(!JSON.stringify(r).includes("should-not-leak"), "审计记录不得包含参数值")
  }
})

test("M4：纯 MCP workflow 合法（toolCount 计入，不触发纯编排检查）", async () => {
  const script = `export const meta = { name: 'm4_pure', mcp: { enabled: true, servers: ['fix'], allowTools: ['fix:*'] } }
const r = await mcp.call('fix', 'add', { a: 2, b: 3 })
return r`
  const result = await run(script, "m4-10")
  assert.equal(String(result.result), "5")
})
