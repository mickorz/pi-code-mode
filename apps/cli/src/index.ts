#!/usr/bin/env node
/**
 * pi-code-mode CLI：不启动交互式 pi 会话，直接跑 / 列 / 查 workflow。
 *
 *   pi-code-mode-cli list [--json]
 *   pi-code-mode-cli run <id|文件> [--args '<json>'] [--concurrency N] [--json]
 *   pi-code-mode-cli resume <runId> [--json]
 *   pi-code-mode-cli status <runId> [--json]
 *
 * 退出码：0 成功 / 1 失败 / 2 用法错误。
 */
import path from "node:path"
import { createRunJournal } from "../../../packages/manager/src/run-journal.js"
import { loadRegistry } from "../../../packages/engine/src/runtime/workflow-registry.js"
import { resolveWorkflowScript, runWorkflowOnce } from "./run-workflow.js"

const USAGE = `pi-code-mode-cli <命令> [选项]

命令：
  list                            列出可用 workflow（项目注册表 + 包内置）
  run <id|文件路径>               执行 workflow
  resume <runId>                  续跑（复用 journal 的最长未变前缀）
  status <runId>                  查看某次 run 的落盘摘要

选项：
  --args '<json>'                 run 的 args 全局（JSON）
  --concurrency <n>               Agent 并发上限
  --json                          机器可读输出（stdout 单行 JSON）
  --help                          帮助

示例：
  pi-code-mode-cli run quality-loop --args '{"target":"packages"}' --concurrency 4
  pi-code-mode-cli status run-abc123 --json`

interface Parsed {
  command: string
  positional: string[]
  args?: unknown
  concurrency?: number
  json: boolean
}

export function parseArgv(argv: string[]): Parsed {
  const [command = "", ...rest] = argv
  const positional: string[] = []
  const parsed: Parsed = { command, positional, json: false }
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!
    if (token === "--json") parsed.json = true
    else if (token === "--args") {
      const raw = rest[++i]
      if (raw === undefined) throw new Error("--args 需要一个 JSON 值")
      try {
        parsed.args = JSON.parse(raw)
      } catch {
        throw new Error(`--args 不是合法 JSON: ${raw}`)
      }
    } else if (token === "--concurrency") {
      const raw = rest[++i]
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 1) throw new Error(`--concurrency 需要正整数: ${raw}`)
      parsed.concurrency = n
    } else if (token.startsWith("--")) throw new Error(`未知选项: ${token}`)
    else positional.push(token)
  }
  return parsed
}

const fail = (message: string): never => {
  console.error(`[pi-code-mode-cli] ${message}`)
  process.exit(2)
}

/** 读 run 摘要；缺失时直接退出（process.exit 返回 never，调用侧类型收窄） */
function requireMeta(cwd: string, runId: string) {
  const meta = createRunJournal(cwd).getRunMetadata(runId)
  if (!meta) {
    console.error(`[pi-code-mode-cli] 未找到 runId ${runId} 的 journal（${path.join(cwd, ".pi/workflows/journal")}）`)
    process.exit(2)
  }
  return meta
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes("--help") || argv[0] === "help") {
    console.log(USAGE)
    return
  }
  const parsed = parseArgv(argv)
  const cwd = process.cwd()

  switch (parsed.command) {
    case "list": {
      const entries = [...loadRegistry(cwd).values()]
      if (parsed.json) {
        console.log(JSON.stringify(entries, null, 2))
        return
      }
      for (const entry of entries) {
        const tag = entry.builtin ? "[内置]" : "[项目]"
        const desc = entry.description ? `  ${entry.description}` : ""
        console.log(`${tag} ${entry.id}${desc}`)
      }
      return
    }
    case "run": {
      const ref = parsed.positional[0]
      if (!ref) fail("run 需要 workflow id 或文件路径")
      const { script, source } = resolveWorkflowScript(cwd, ref)
      const { runId, result, error } = await runWorkflowOnce({
        cwd,
        script,
        source,
        args: parsed.args,
        concurrency: parsed.concurrency,
        onRuntimeEvent: parsed.json ? undefined : (event) => {
          const e = event as { type?: string; nodeId?: string }
          if (e.type) console.error(`[event] ${e.type}${e.nodeId ? ` ${e.nodeId}` : ""}`)
        },
      })
      if (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (parsed.json) console.log(JSON.stringify({ runId, status: "failed", error: message }))
        else console.error(`[失败] ${message}（日志：.pi/workflows/journal/${runId}.json）`)
        process.exit(1)
      }
      if (parsed.json) console.log(JSON.stringify({ runId, status: "ok", result: result?.result, durationMs: result?.durationMs }))
      else console.log(`[成功] runId=${runId} 用时 ${result?.durationMs ?? 0}ms\n${JSON.stringify(result?.result, null, 2)}`)
      return
    }
    case "resume": {
      const runId = parsed.positional[0]
      if (!runId) fail("resume 需要 runId")
      const meta = requireMeta(cwd, runId)
      if (!meta.workflowId) fail(`runId ${runId} 无可续跑的 workflowId（摘要未写入）`)
      const { script, source } = resolveWorkflowScript(cwd, meta.workflowId as string)
      const outcome = await runWorkflowOnce({ cwd, script, source, resumeFromRunId: runId })
      if (outcome.error) {
        const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
        console.error(`[失败] ${message}`)
        process.exit(1)
      }
      console.log(parsed.json ? JSON.stringify({ runId, status: "ok" }) : `[成功] 已从 ${runId} 续跑`)
      return
    }
    case "status": {
      const runId = parsed.positional[0]
      if (!runId) fail("status 需要 runId")
      const journal = createRunJournal(cwd)
      const meta = requireMeta(cwd, runId)
      const observability = journal.getObservability(runId)
      if (parsed.json) {
        console.log(JSON.stringify({ runId, metadata: meta, observability }, null, 2))
        return
      }
      console.log(`runId:  ${runId}`)
      console.log(`workflow: ${meta.workflowId ?? "(未记录)"} ${meta.workflowName ?? ""}`)
      console.log(`status: ${meta.status ?? "(未记录)"}${meta.error ? ` — ${meta.error}` : ""}`)
      if (meta.startedAt && meta.endedAt) console.log(`duration: ${meta.endedAt - meta.startedAt}ms`)
      const agents = observability?.agents as unknown[] | undefined
      if (agents) console.log(`agents: ${agents.length}`)
      return
    }
    default:
      fail(`未知命令 "${parsed.command}"（--help 查看用法）`)
  }
}

// 直接执行时才跑 main（被 tests 导入时只拿 parseArgv）
if (process.argv[1] && path.resolve(process.argv[1]).includes(path.join("apps", "cli"))) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[pi-code-mode-cli] ${message}`)
    process.exit(1)
  })
}
