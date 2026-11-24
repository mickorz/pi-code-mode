#!/usr/bin/env node
/**
 * pi-code-mode runner：无头执行 workflow，面向进程管理（CI / 后台 / 容器）。
 *
 *   pi-code-mode-runner <id|文件> [--args '<json>'] [--concurrency N]
 *
 * 与 CLI 的差别（不是重复实现：执行装配共用 apps/cli/src/run-workflow.ts）：
 *   - stdout 只输出一行 JSON 结果（进度与日志走 stderr），便于被父进程解析
 *   - SIGTERM/SIGINT → abort 当前 run，退出码 143/130
 *   - 退出码直接反映成败：0 成功 / 1 失败 / 2 用法错误
 */
import { resolveWorkflowScript, runWorkflowOnce } from "../../cli/src/run-workflow.js"

const USAGE = `pi-code-mode-runner <id|文件路径> [--args '<json>'] [--concurrency N]`

function parse(argv: string[]) {
  const positional: string[] = []
  let args: unknown
  let concurrency: number | undefined
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === "--help" || token === "-h") {
      console.log(USAGE)
      process.exit(0)
    } else if (token === "--args") {
      const raw = argv[++i]
      if (raw === undefined) throw new Error("--args 需要一个 JSON 值")
      args = JSON.parse(raw)
    } else if (token === "--concurrency") {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n < 1) throw new Error("--concurrency 需要正整数")
      concurrency = n
    } else if (token.startsWith("--")) throw new Error(`未知选项: ${token}`)
    else positional.push(token)
  }
  return { positional, args, concurrency }
}

async function main(): Promise<void> {
  const parsed = parse(process.argv.slice(2))
  const ref = parsed.positional[0]
  if (!ref) {
    console.error(USAGE)
    process.exit(2)
  }
  const cwd = process.cwd()
  const { script, source } = resolveWorkflowScript(cwd, ref)

  const controller = new AbortController()
  let received: NodeJS.Signals | undefined
  const onSignal = (signal: NodeJS.Signals) => {
    received = signal
    console.error(`[runner] 收到 ${signal}，正在中止 run`)
    controller.abort()
  }
  process.once("SIGTERM", onSignal)
  process.once("SIGINT", onSignal)

  const { runId, result, error } = await runWorkflowOnce({
    cwd,
    script,
    source,
    args: parsed.args,
    concurrency: parsed.concurrency,
    signal: controller.signal,
    onAgentUpdate: (record: unknown) => {
      const r = record as { label?: string; status?: string }
      console.error(`[agent] ${r.status ?? "?"} ${r.label ?? ""}`)
    },
  })

  if (controller.signal.aborted) {
    console.log(JSON.stringify({ runId, status: "aborted", signal: received }))
    process.exit(received === "SIGINT" ? 130 : 143)
  }
  if (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(JSON.stringify({ runId, status: "failed", error: message }))
    process.exit(1)
  }
  console.log(JSON.stringify({ runId, status: "ok", result: result?.result, durationMs: result?.durationMs }))
}

main().catch((error) => {
  console.error(`[pi-code-mode-runner] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
