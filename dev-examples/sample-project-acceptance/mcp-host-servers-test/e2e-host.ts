/**
 * MCP 集成验收（宿主真实 MCP server）：完整 workflow 链路 PiAgentAdapter → runWorkflow → JournalStore
 *
 * 测试对象：宿主 ~/.pi/agent/mcp.json 中的真实 server（HTTP 类，连接快且无浏览器依赖）
 *   - web-reader（mcp__web_reader__webReader）
 *   - zread（mcp__zread__get_repo_structure 等）
 *   - web-search-prime（mcp__web_search_prime__web_search_prime）
 * 注：codegraph 由宿主扩展运行时注册（不在 mcp.json），子会话按文件配置读取天然不含——见报告说明。
 *
 * 用例：
 *   1 放行：web-reader 白名单 → 模型经 tool_search 加载并调用 webReader 读网页 → journal toolCalls 记录
 *   2 放行：zread 白名单 → 调 get_repo_structure 读 GitHub repo 结构 → 成功
 *   3 deny：denyTools 压过 allowTools → 调用不可达
 *   4 默认拒绝：servers 白名单不含 web-reader → 其工具不可达
 *
 * 隔离：PI_CODING_AGENT_DIR 临时目录（复制凭证/设置剥 packages；mcp.json 原样复制宿主件）
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { agentAdapterToRunner } from "../../../src/adapter/agent-adapter.js"
import { PiAgentAdapter } from "../../../src/adapter/pi-agent-adapter.js"
import { JournalStore } from "../../../src/engine/persistence/journal.js"
import { runWorkflow } from "../../../src/engine/runtime/workflow-runtime.js"
import type { JournalEntry } from "../../../src/engine/types/index.js"

const HOST = process.env.PI_CODING_AGENT_DIR_ORIGINAL ?? path.join(os.homedir(), ".pi", "agent")

interface CaseResult {
  name: string
  pass: boolean
  details: string[]
}
const results: CaseResult[] = []
function check(c: CaseResult, ok: boolean, msg: string): void {
  c.details.push(`${ok ? "PASS" : "FAIL"} ${msg}`)
  if (!ok) c.pass = false
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${msg}`)
}

function prepareAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpsrv-agent-"))
  for (const f of ["auth.json", "models.json"]) {
    const src = path.join(HOST, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f))
  }
  const st = JSON.parse(fs.readFileSync(path.join(HOST, "settings.json"), "utf8"))
  delete st.packages
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(st, null, 2))
  fs.copyFileSync(path.join(HOST, "mcp.json"), path.join(dir, "mcp.json"))
  return dir
}

async function runCase(
  name: string,
  tools: Record<string, unknown>,
  prompt: string,
  runId: string,
): Promise<{ c: CaseResult; reply: string; entries: Array<JournalEntry & { key: string }> }> {
  const c: CaseResult = { name, pass: true, details: [] }
  console.log(`\n== ${name} ==`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `mcpsrv-${runId}-`))
  const agentDir = prepareAgentDir()
  process.env.PI_CODING_AGENT_DIR = agentDir

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mcpsrv-cwd-"))
  const adapter = new PiAgentAdapter({ agentDir })
  const runner = agentAdapterToRunner(adapter)
  const journal = new JournalStore(cwd)
  const entries: Array<JournalEntry & { key: string }> = []

  const script = `export const meta = { name: '${runId.replace(/-/g, "_")}' }
const r = await agent(${JSON.stringify(prompt)}, { tools: ${JSON.stringify(tools)} })
return r`

  const result = await runWorkflow(script, {
    runId,
    agent: runner,
    cwd,
    concurrency: 1,
    agentTimeoutMs: 240000,
    onAgentJournal: (entry) => {
      entries.push(entry)
      journal.append(runId, entry.key, entry)
    },
  })
  const reply = typeof result.result === "string" ? result.result : JSON.stringify(result.result)
  return { c, reply, entries }
}

async function main() {
  // 用例 1：web-reader 放行
  {
    const { c, reply, entries } = await runCase(
      "E2E-1 web-reader 放行：读网页成功且入 journal",
      { mcp: { enabled: true, servers: ["web-reader"], allowTools: ["web-reader:*"] } },
      `The tool mcp__web_reader__webReader is not declared yet. Use the tool_search tool to search "webReader", load it, then call it with url "https://example.com". Report the page title you found.`,
      "mcpsrv-1",
    )
    check(c, /example/i.test(reply), `workflow 输出含目标网页痕迹（reply=${reply.slice(0, 150)}）`)
    const entry = entries.find((e) => e.toolCalls?.length)
    check(c, Boolean(entry), "journal entry 含 toolCalls")
    const tc = entry?.toolCalls?.find((t) => t.toolName === "mcp__web_reader__webReader")
    check(c, Boolean(tc), `toolCalls 含 mcp__web_reader__webReader（实际=${JSON.stringify(entry?.toolCalls?.map((t) => t.toolName))}）`)
    check(c, tc?.status === "ok", `toolCall status=${tc?.status}`)
    results.push(c)
  }

  // 用例 2：zread 放行
  {
    const { c, reply, entries } = await runCase(
      "E2E-2 zread 放行：读 GitHub repo 结构成功",
      { mcp: { enabled: true, servers: ["zread"], allowTools: ["zread:*"] } },
      `The tool mcp__zread__get_repo_structure is not declared yet. Use the tool_search tool to search "repo structure", load it, then call it with repo_name "earendil-works/pi". Report any top-level entry you saw.`,
      "mcpsrv-2",
    )
    check(c, reply.length > 20 && !/TOOL UNAVAILABLE|unavailable|无法/i.test(reply), `workflow 输出非空且未报不可用（reply=${reply.slice(0, 150)}）`)
    const entry = entries.find((e) => e.toolCalls?.length)
    const tc = entry?.toolCalls?.find((t) => t.toolName === "mcp__zread__get_repo_structure")
    check(c, Boolean(tc), `journal toolCalls 含 mcp__zread__get_repo_structure（实际=${JSON.stringify(entry?.toolCalls?.map((t) => t.toolName))}）`)
    check(c, tc?.status === "ok", `toolCall status=${tc?.status}`)
    results.push(c)
  }

  // 用例 3：deny 压过 allow
  {
    const { c, reply, entries } = await runCase(
      "E2E-3 deny：denyTools 压过 allowTools",
      {
        mcp: {
          enabled: true,
          servers: ["web-reader"],
          allowTools: ["web-reader:*"],
          denyTools: ["web-reader:webReader"],
        },
      },
      `Try to call the mcp__web_reader__webReader tool with url "https://example.com". It may need loading via tool_search first. If the tool is not found or cannot be called, say exactly: TOOL BLOCKED.`,
      "mcpsrv-3",
    )
    const mcpCalls = entries.flatMap((e) => e.toolCalls ?? [])
    check(c, !mcpCalls.some((t) => t.toolName === "mcp__web_reader__webReader" && t.status === "ok"), `被拒工具无成功调用记录（实际=${JSON.stringify(mcpCalls.map((t) => `${t.toolName}:${t.status}`))}）`)
    check(c, /TOOL BLOCKED|not found|cannot|无法|blocked|denied/i.test(reply), `模型确认工具不可达（reply=${reply.slice(0, 150)}）`)
    results.push(c)
  }

  // 用例 4：默认拒绝（servers 白名单不含 web-reader）
  {
    const { c, reply, entries } = await runCase(
      "E2E-4 默认拒绝：白名单外的 server 工具不可达",
      { mcp: { enabled: true, servers: ["web-search-prime"], allowTools: ["web-search-prime:*"] } },
      `Try to call the mcp__web_reader__webReader tool with url "https://example.com". It may need loading via tool_search first. If the tool is not found or cannot be called, say exactly: TOOL BLOCKED.`,
      "mcpsrv-4",
    )
    const mcpCalls = entries.flatMap((e) => e.toolCalls ?? [])
    check(c, !mcpCalls.some((t) => t.toolName.startsWith("mcp__web_reader")), `白名单外 server 零调用记录（实际=${JSON.stringify(mcpCalls.map((t) => t.toolName))}）`)
    check(c, /TOOL BLOCKED|not found|cannot|无法|blocked|denied/i.test(reply), `模型确认工具不可达（reply=${reply.slice(0, 150)}）`)
    results.push(c)
  }

  console.log("\n== 验收结果 ==")
  let allPass = true
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}`)
    if (!r.pass) {
      allPass = false
      for (const d of r.details.filter((d) => d.startsWith("FAIL"))) console.log(`    ${d}`)
    }
  }
  process.exit(allPass ? 0 : 1)
}

main().catch((e) => {
  console.error("验收执行失败:", e)
  process.exit(1)
})
