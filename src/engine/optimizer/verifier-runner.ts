/**
 * Verifier 真实执行（P0-1，2026-11-23）
 *
 * 为什么必须自己实现：此前 runVerifier 是 stub（无条件 ok:true），
 * 用户传 `--verify-cmd "npm test"` 但命令根本没跑，质量门却判 pass
 * → benchmark 可能 accepted → 未验证代码写进生产文件。
 *
 * 硬约束：
 *  - cwd 必须是 after 工作区（不能在生产目录跑验证，避免污染）
 *  - 超时即失败（不能当通过）
 *  - 命令不存在 / 非零退出码 → 失败
 *  - 记录 exitCode / stdout / stderr 供 benchmark.md 审计
 *  - 不用 exec（shell 注入面大）：拆成 argv + execFile；需要 shell 语义时显式 `sh -c`
 */
import { execFile } from "node:child_process"

export interface VerifierResult {
  ok: boolean
  /** 退出码（null = 被信号终止或超时） */
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  /** 人类可读结论（写进 benchmark.md） */
  note: string
}

export const DEFAULT_VERIFIER_TIMEOUT_MS = 300_000

/**
 * 最小 argv 解析：处理单/双引号与反斜杠转义。
 *
 * 为什么不能用 split(/\s+/)：实测 `node -e "process.exit(1)"` 会被拆成
 * ["node", "-e", "\"process.exit(1)\""] —— 引号变成参数的一部分，
 * node 把整串当一个字符串字面量求值 → 退出码意外为 0，verifier 假通过。
 */
export function splitArgs(command: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: '"' | "'" | null = null
  let has = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) {
      if (ch === quote) {
        quote = null
        continue
      }
      if (ch === "\\" && i + 1 < command.length) {
        cur += command[++i]
        continue
      }
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'"
      has = true
      continue
    }
    if (/\s/.test(ch)) {
      if (has) {
        out.push(cur)
        cur = ""
        has = false
      }
      continue
    }
    cur += ch
    has = true
  }
  if (has) out.push(cur)
  return out
}

/**
 * 把命令串拆成 argv。
 *
 * 支持两种形态：
 *  - 简单命令：`npm test` → ["npm", "test"]
 *  - 需要 shell 语义（管道/重定向）：写成 `sh -c "..."` 或 `bash -c "..."`，原样保留 -c 后整串
 *
 * 引号处理见 splitArgs；不处理通配符与环境变量展开（需要时用 sh -c）。
 */
export function parseVerifierCommand(command: string): { file: string; args: string[] } | { error: string } {
  const trimmed = command.trim()
  if (!trimmed) return { error: "verifier 命令为空" }
  const tokens = splitArgs(trimmed)
  const file = tokens[0]
  if (!file) return { error: "verifier 命令为空" }
  const args = tokens.slice(1)
  // sh -c "整串"：splitArgs 已去掉外层引号，直接透传
  if ((file === "sh" || file === "bash" || file === "cmd") && args[0] === "-c") {
    return { file, args: ["-c", args.slice(1).join(" ")] }
  }
  return { file, args }
}

/** 真实执行 verifier（cwd 必须是 after 工作区） */
export function runVerifierCommand(input: {
  command: string
  cwd: string
  timeoutMs?: number
}): Promise<VerifierResult> {
  const parsed = parseVerifierCommand(input.command)
  if ("error" in parsed) {
    return Promise.resolve({
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: parsed.error,
      durationMs: 0,
      note: `verifier 拒绝执行：${parsed.error}`,
    })
  }
  const timeout = input.timeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS
  const started = Date.now()

  return new Promise((resolve) => {
    const child = execFile(
      parsed.file,
      parsed.args,
      {
        cwd: input.cwd,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        // 不继承交互式 stdin：verifier 不应等待用户输入
        env: { ...process.env, CI: process.env.CI ?? "1" },
      },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - started
        const out = String(stdout ?? "").slice(-4000)
        const errOut = String(stderr ?? "").slice(-4000)
        if (!err) {
          resolve({ ok: true, exitCode: 0, stdout: out, stderr: errOut, durationMs, note: `verifier 通过（${Math.round(durationMs / 1000)}s）` })
          return
        }
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }
        const killed = Boolean(e.killed) || e.signal === "SIGTERM"
        const exitCode = typeof e.code === "number" ? e.code : null
        const note = killed
          ? `verifier 超时（${Math.round(timeout / 1000)}s），按失败处理`
          : e.code === "ENOENT"
            ? `verifier 命令不存在：${parsed.file}`
            : `verifier 失败（exit ${exitCode ?? e.code ?? "?"}）`
        resolve({ ok: false, exitCode, stdout: out, stderr: errOut, durationMs, note })
      },
    )
    // 防御：子进程异常退出时确保 promise 有结论
    child.on("error", (e) => {
      resolve({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: String((e as Error)?.message ?? e),
        durationMs: Date.now() - started,
        note: `verifier 启动失败：${String((e as Error)?.message ?? e)}`,
      })
    })
  })
}

/** 渲染 verifier 结果为 benchmark.md 片段 */
export function renderVerifier(r: VerifierResult, command: string): string {
  const lines = [
    `- verifier：\`${command}\``,
    `- 结论：${r.ok ? "通过" : "**失败**"}（${r.note}）`,
    `- 退出码：${r.exitCode ?? "null"} / 耗时：${r.durationMs}ms`,
  ]
  if (r.stdout.trim()) lines.push("", "stdout（末 4000 字）：", "```", r.stdout.trim(), "```")
  if (r.stderr.trim()) lines.push("", "stderr（末 4000 字）：", "```", r.stderr.trim(), "```")
  return lines.join("\n")
}
