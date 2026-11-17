/**
 * M2 端到端联调：真实 workflow 链路（PiAgentAdapter → runWorkflow → JournalStore）+ 真实模型 + MCP fixture
 *
 * 用例 1（放行）：tools.mcp { servers:["fix"], allowTools:["fix:echo"] } → 模型调 echo 成功，
 *                journal entry.toolCalls 含 mcp__fix__echo 摘要，调用到达 server
 * 用例 2（拒绝）：denyTools:["fix:echo"] + allowTools:["fix:*"] → 调用被拒，未到达 server
 * 用例 3（未授权 server 零连接）：servers:["other"]（mcp.json 无此 server）→ 无 MCP 工具，调用不可达
 *
 * 隔离：PI_CODING_AGENT_DIR 指向临时目录（复制宿主 auth/settings/models 凭证；mcp.json 仅 fixture），
 *       不读写宿主 mcp.json（含真实凭证，绝不触碰）
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { agentAdapterToRunner } from "../../src/adapter/agent-adapter.js"
import { PiAgentAdapter } from "../../src/adapter/pi-agent-adapter.js"
import { JournalStore } from "../../src/engine/persistence/journal.js"
import { runWorkflow } from "../../src/engine/runtime/workflow-runtime.js"
import type { JournalEntry, McpToolCallSummary } from "../../src/engine/types/index.js"

const HOST_AGENT_DIR = process.env.PI_CODING_AGENT_DIR_ORIGINAL ?? path.join(os.homedir(), ".pi", "agent")
const MARKER = "m2-e2e-marker"

interface CaseResult {
  name: string
  pass: boolean
  details: string[]
}

const results: CaseResult[] = []

function makeCase(name: string): CaseResult {
  return { name, pass: true, details: [] }
}
function check(c: CaseResult, ok: boolean, msg: string): void {
  c.details.push(`${ok ? "PASS" : "FAIL"} ${msg}`)
  if (!ok) c.pass = false
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${msg}`)
}

/** 准备隔离 agentDir：复制凭证文件 + 写 fixture mcp.json */
function prepareAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m2-agent-"))
  for (const f of ["auth.json", "models.json"]) {
    const src = path.join(HOST_AGENT_DIR, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f))
  }
  // settings.json 剥掉 packages（宿主包列表会触发 clone+install，实测拖慢 165s+）
  const settingsSrc = path.join(HOST_AGENT_DIR, "settings.json")
  if (fs.existsSync(settingsSrc)) {
    const settings = JSON.parse(fs.readFileSync(settingsSrc, "utf8"))
    delete settings.packages
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings, null, 2), "utf8")
  }
  const serverEntry = path.join(import.meta.dirname, "..", "mcp-m0-verification", "fixture", "echo-mcp-server.mjs")
  fs.writeFileSync(
    path.join(dir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        fix: { type: "stdio", command: process.execPath, args: [serverEntry] },
      },
    }),
    "utf8",
  )
  return dir
}

async function runCase(
  name: string,
  tools: Record<string, unknown>,
  prompt: string,
  runId: string,
): Promise<{ c: CaseResult; reply: string; journal: JournalStore; entries: Array<JournalEntry & { key: string }>; callsLog: string; pidLog: string }> {
  const c = makeCase(name)
  console.log(`\n== ${name} ==`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `m2-${runId}-`))
  const agentDir = prepareAgentDir()
  const callsLog = path.join(tmp, "calls.log")
  const pidLog = path.join(tmp, "pids.log")
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.FIXTURE_CALL_LOG = callsLog
  process.env.FIXTURE_PID_LOG = pidLog

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "m2-cwd-"))
  const adapter = new PiAgentAdapter({ agentDir })
  const runner = agentAdapterToRunner(adapter)
  const journal = new JournalStore(cwd)
  const entries: Array<JournalEntry & { key: string }> = []
  const executions: Array<{ key: string; execution: unknown }> = []

  const script = `export const meta = { name: '${runId.replace(/-/g, "_")}' }
const r = await agent(${JSON.stringify(prompt)}, { tools: ${JSON.stringify(tools)} })
return r`

  const result = await runWorkflow(script, {
    runId,
    agent: runner,
    cwd,
    concurrency: 1,
    agentTimeoutMs: 180000,
    onAgentJournal: (entry) => {
      entries.push(entry)
      journal.append(runId, entry.key, entry)
    },
    onAgentExecution: (payload) => {
      executions.push(payload)
      journal.recordExecution(runId, payload.key, payload.execution)
    },
  })

  const reply = typeof result.result === "string" ? result.result : JSON.stringify(result.result)
  return { c, reply, journal, entries, callsLog, pidLog }
}

async function main() {
  // 用例 1：放行
  {
    const { c, reply, entries, callsLog } = await runCase(
      "E2E-1 放行：echo 调用成功且入 journal",
      { mcp: { enabled: true, servers: ["fix"], allowTools: ["fix:echo"] } },
      `Call the mcp__fix__echo tool with {"text":"${MARKER}"}. Report the exact text the tool returned.`,
      "m2-e2e-1",
    )
    check(c, reply.includes(MARKER), `workflow 输出含 marker（reply=${reply.slice(0, 120)}）`)
    const calls = fs.existsSync(callsLog) ? fs.readFileSync(callsLog, "utf8").split("\n").filter(Boolean) : []
    check(c, calls.includes("echo"), `调用到达 server（calls=${JSON.stringify(calls)}）`)
    const entry = entries.find((e) => e.toolCalls?.length)
    check(c, Boolean(entry), "journal entry 含 toolCalls 字段")
    const tc = entry?.toolCalls?.[0]
    check(c, tc?.toolName === "mcp__fix__echo", `toolCalls[0].toolName=${tc?.toolName}`)
    check(c, tc?.status === "ok", `toolCalls[0].status=${tc?.status}`)
    check(c, typeof tc?.durationMs === "number", `toolCalls[0].durationMs=${tc?.durationMs}`)
    check(c, Array.isArray(tc?.argsKeys) && tc.argsKeys.includes("text"), `toolCalls[0].argsKeys=${JSON.stringify(tc?.argsKeys)}`)
    results.push(c)
  }

  // 用例 2：拒绝
  {
    const { c, reply, callsLog } = await runCase(
      "E2E-2 拒绝：denyTools 压过 allowTools",
      { mcp: { enabled: true, servers: ["fix"], allowTools: ["fix:*"], denyTools: ["fix:echo"] } },
      `Call the mcp__fix__echo tool with {"text":"denied-marker"}. Report what happened (result or error).`,
      "m2-e2e-2",
    )
    const calls = fs.existsSync(callsLog) ? fs.readFileSync(callsLog, "utf8").split("\n").filter(Boolean) : []
    check(c, !calls.includes("echo"), `被拒调用未到达 server（calls=${JSON.stringify(calls)}）`)
    check(
      c, /policy|denied|not allowed|无法|拒绝|blocked|hidden|no longer available/i.test(reply),
      `模型报告拒绝（reply=${reply.slice(0, 150)}）`,
    )
    results.push(c)
  }

  // 用例 3：未授权 server 零连接
  {
    const { c, reply, callsLog, pidLog } = await runCase(
      "E2E-3 未授权 server 零连接（默认拒绝）",
      { mcp: { enabled: true, servers: ["other"] } },
      `Call the mcp__fix__echo tool with {"text":"nope"}. If the tool is not available, say exactly: TOOL UNAVAILABLE.`,
      "m2-e2e-3",
    )
    const calls = fs.existsSync(callsLog) ? fs.readFileSync(callsLog, "utf8").split("\n").filter(Boolean) : []
    check(c, !calls.includes("echo"), `未授权 server 的工具调用未到达 server（calls=${JSON.stringify(calls)}）`)
    const pids = fs.existsSync(pidLog) ? fs.readFileSync(pidLog, "utf8").split("\n").filter((l) => l.startsWith("pid=")) : []
    check(c, pids.length === 0, `未授权 server 进程零启动（pids=${JSON.stringify(pids)}）`)
    check(c, /TOOL UNAVAILABLE|not available|unavailable|无法|不存在/i.test(reply), `模型确认工具不可用（reply=${reply.slice(0, 150)}）`)
    results.push(c)
  }

  // 汇总
  console.log("\n== E2E 结果 ==")
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
  console.error("E2E 执行失败:", e)
  process.exit(1)
})
