/**
 * 真实 workflow 脚本运行器：加载 workflows/*.workflow.js 源码 → runWorkflow 执行
 * （与宿主 workflow 工具同一执行路径：同一 vm 编译、同一 agent DSL、同一 JournalStore）
 *
 * 用法：PI_CODING_AGENT_DIR_ORIGINAL=~/.pi/agent npx tsx run-workflows.ts [脚本名...]
 *   缺省跑全部 4 个；传名字（如 mcp-web-reader）只跑指定项
 *
 * 断言（从外部 journal 观察，不信任脚本返回值）：
 *   - web-reader/zread：journal entry.toolCalls 含期望工具且 status=ok
 *   - deny：无任何 webReader 成功调用
 *   - parallel：两个 Agent 的 toolCalls 各含各自 server 的工具（权限隔离 + 并行编排）
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
const WORKFLOWS_DIR = path.join(import.meta.dirname, "workflows")

interface Spec {
  file: string
  runId: string
  expect: Array<{ toolName: string; status: "ok" }>
  forbid?: Array<{ toolName: string }>
}

const SPECS: Spec[] = [
  {
    file: "mcp-web-reader.workflow.js",
    runId: "mcp-wf-reader",
    expect: [{ toolName: "mcp__web_reader__webReader", status: "ok" }],
  },
  {
    file: "mcp-zread.workflow.js",
    runId: "mcp-wf-zread",
    expect: [{ toolName: "mcp__zread__get_repo_structure", status: "ok" }],
  },
  {
    file: "mcp-deny.workflow.js",
    runId: "mcp-wf-deny",
    expect: [],
    forbid: [{ toolName: "mcp__web_reader__webReader" }],
  },
  {
    file: "mcp-parallel.workflow.js",
    runId: "mcp-wf-parallel",
    expect: [
      { toolName: "mcp__web_reader__webReader", status: "ok" },
      { toolName: "mcp__zread__get_repo_structure", status: "ok" },
    ],
  },
]

function prepareAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpsrv-agent-"))
  for (const f of ["auth.json", "models.json"]) {
    const src = path.join(HOST, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f))
  }
  // settings.json 剥 packages（宿主包列表触发逐包 clone+install，实测 200s+）
  const st = JSON.parse(fs.readFileSync(path.join(HOST, "settings.json"), "utf8"))
  delete st.packages
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(st, null, 2))
  // 宿主 mcp.json 原样复制（真实配置即测试对象）
  fs.copyFileSync(path.join(HOST, "mcp.json"), path.join(dir, "mcp.json"))
  return dir
}

async function runOne(spec: Spec): Promise<{ pass: boolean; details: string[] }> {
  const details: string[] = []
  console.log(`\n== ${spec.file}（runId=${spec.runId}）==`)
  const t0 = Date.now()
  const agentDir = prepareAgentDir()
  process.env.PI_CODING_AGENT_DIR = agentDir
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `mcpsrv-cwd-`))

  const script = fs.readFileSync(path.join(WORKFLOWS_DIR, spec.file), "utf8")
  const adapter = new PiAgentAdapter({ agentDir })
  const runner = agentAdapterToRunner(adapter)
  const journal = new JournalStore(cwd)
  const entries: Array<JournalEntry & { key: string }> = []

  const result = await runWorkflow(script, {
    runId: spec.runId,
    agent: runner,
    cwd,
    concurrency: 2,
    agentTimeoutMs: 240000,
    onAgentJournal: (entry) => {
      entries.push(entry)
      journal.append(spec.runId, entry.key, entry)
    },
  })

  const resultStr = JSON.stringify(result.result ?? "")
  details.push(`耗时 ${Date.now() - t0}ms`)

  // 断言 1：期望工具全部以期望状态出现在 journal toolCalls
  const allCalls = entries.flatMap((e) => e.toolCalls ?? [])
  for (const exp of spec.expect) {
    const hit = allCalls.find((t) => t.toolName === exp.toolName && t.status === exp.status)
    details.push(`${hit ? "PASS" : "FAIL"} journal toolCalls 含 ${exp.toolName}(${exp.status})；实际=${JSON.stringify(allCalls.map((t) => `${t.toolName}:${t.status}`))}`)
    if (!hit) return { pass: false, details }
  }
  // 断言 2：禁止工具无成功调用
  for (const f of spec.forbid ?? []) {
    const bad = allCalls.find((t) => t.toolName === f.toolName && t.status === "ok")
    details.push(`${bad ? "FAIL" : "PASS"} 禁止工具 ${f.toolName} 无成功调用`)
    if (bad) return { pass: false, details }
  }
  // 断言 3：workflow 返回值非空
  details.push(`${resultStr.length > 2 ? "PASS" : "FAIL"} workflow 返回值非空（${resultStr.slice(0, 120)}）`)
  if (resultStr.length <= 2) return { pass: false, details }

  // 证据落盘
  const evidenceDir = path.join(import.meta.dirname, "results")
  fs.mkdirSync(evidenceDir, { recursive: true })
  fs.writeFileSync(
    path.join(evidenceDir, `${spec.runId}.json`),
    JSON.stringify({ runId: spec.runId, file: spec.file, result: result.result, toolCalls: allCalls, entries }, null, 2),
    "utf8",
  )
  return { pass: true, details }
}

async function main() {
  const only = process.argv.slice(2)
  const specs = only.length > 0 ? SPECS.filter((s) => only.some((o) => s.file.includes(o) || s.runId.includes(o))) : SPECS
  let allPass = true
  for (const spec of specs) {
    const { pass, details } = await runOne(spec)
    for (const d of details) console.log(`  ${d.startsWith("PASS") || d.startsWith("FAIL") ? d : "  [info] " + d}`)
    console.log(`${pass ? "PASS" : "FAIL"} ${spec.file}`)
    allPass = allPass && pass
  }
  console.log(`\n== 总结果：${allPass ? "全部通过" : "存在失败"} ==`)
  process.exit(allPass ? 0 : 1)
}

main().catch((e) => {
  console.error("运行失败:", e)
  process.exit(1)
})
