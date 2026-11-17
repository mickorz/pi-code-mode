/**
 * M4 验收 runner：直调形态（mcp.call / tools.mcp__* proxy / listTools / listServers）
 * 宿主真实 web-reader + zread；不经子 Agent（fake runner 永不触发，纯 MCP workflow）
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { agentAdapterToRunner } from "../../../src/adapter/agent-adapter.js"
import { PiAgentAdapter } from "../../../src/adapter/pi-agent-adapter.js"
import { runWorkflow } from "../../../src/engine/runtime/workflow-runtime.js"

const HOST = process.env.PI_CODING_AGENT_DIR_ORIGINAL ?? path.join(os.homedir(), ".pi", "agent")

function prepareAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m4-agent-"))
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

const checks: Array<{ name: string; pass: boolean }> = []
function check(name: string, pass: boolean): void {
  checks.push({ name, pass })
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}`)
}

async function main() {
  console.log("== M4 验收：workflow 直调 MCP（宿主真实 web-reader/zread）==")
  const dir = prepareAgentDir()
  process.env.PI_CODING_AGENT_DIR = dir
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "m4-cwd-"))

  const adapter = new PiAgentAdapter({ agentDir: dir })
  const runner = agentAdapterToRunner(adapter)
  const script = fs.readFileSync(
    path.join(import.meta.dirname, "workflows", "mcp-direct.workflow.js"),
    "utf8",
  )

  const t0 = Date.now()
  const result = await runWorkflow(script, {
    runId: "m4-direct-1",
    agent: runner,
    cwd,
    concurrency: 1,
    onMcpCall: (r) => console.log(`  [audit] ${r.server}/${r.toolName} ${r.status} ${r.durationMs ?? "-"}ms argsBytes=${r.argsBytes}`),
  })
  const out = result.result as { pageTitle: string; zreadTools: string[]; repo: unknown; servers: string[] }
  console.log(`耗时 ${Date.now() - t0}ms`)

  check("mcp.call(web-reader, webReader) 读网页成功", String(JSON.stringify(out.pageTitle)).includes("Example"), `pageTitle=${JSON.stringify(out.pageTitle).slice(0, 120)}`)
  check("mcp.listTools(zread) 返回工具清单", Array.isArray(out.zreadTools) && out.zreadTools.length > 0, `tools=${JSON.stringify(out.zreadTools)}`)
  check("tools.mcp__zread__get_repo_structure proxy 调用成功", Boolean(out.repo), `repo=${JSON.stringify(out.repo).slice(0, 120)}`)
  check("mcp.listServers 返回白名单", JSON.stringify(out.servers) === JSON.stringify(["web-reader", "zread"]), `servers=${JSON.stringify(out.servers)}`)
  check("fake runner 未被触发（纯 MCP workflow，不经子 Agent）", result.agentCount === 0, `agentCount=${result.agentCount}`)
  check("toolCount 计入直调（纯 MCP workflow 合法）", result.toolCount >= 3, `toolCount=${result.toolCount}`)

  console.log(`\n== 总结果：${checks.every((c) => c.pass) ? "全部通过" : "存在失败"} ==`)
  process.exit(checks.every((c) => c.pass) ? 0 : 1)
}

main().catch((e) => {
  console.error("M4 验收失败:", e)
  process.exit(1)
})
