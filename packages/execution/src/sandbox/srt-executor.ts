/**
 * SrtCommandExecutor —— CommandExecutor 的 SRT 实现（M2.0/M2.1/M2.3/M2.5）
 *
 * 每条命令 spawn 一个独立 Sandbox Host 进程（见 sandbox-host.ts 的"为什么独立进程"）。
 *
 * 平台策略（M2.5）：Windows 直接返回 isolation_unavailable，不 spawn、不降级宿主执行。
 * 注意不要依赖 SRT 的 isSupportedPlatform()——0.0.81 的 Windows Alpha 后端对 windows 也返回 true，
 * 但本项目的隔离承诺只为 darwin/linux 背书。
 *
 * 取消语义（评审第一处细节）：SRT 的 abortSignal 只覆盖包裹阶段，"杀正在跑的命令"必须由这里做：
 *   abort/timeout -> kill(-hostPid, SIGTERM) -> 宽限期 -> SIGKILL -> 等 Host 退出 -> drain 输出
 * Host 是进程组长且把命令放在同组，所以杀组即杀命令与其派生进程，不留孤儿。
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { sandboxPlatformSupported } from "./sandbox-config.js"
import type { SandboxHostPayload } from "./sandbox-host.js"
import type { CommandExecutor, SandboxCommandRequest, SandboxCommandResult } from "../command/types.js"

/** 停止宽限期：SIGTERM 后多久 SIGKILL */
const STOP_GRACE_MS = 3000
/** 默认超时（毫秒）：0 = 不限 */
const DEFAULT_TIMEOUT_MS = 120_000
/** 输出上限（每流，字节）：超限截断并标注，防巨量输出打爆父进程内存 */
const MAX_OUTPUT_BYTES = 1024 * 1024

interface HostEntry {
  script: string
  execArgv: string[]
}

/**
 * 定位 Host 入口：优先用同目录已编译的 .js（发布产物）；开发态（jiti 直载 TS）退回 tsx 加载器。
 * 用绝对路径喂 --import，避免子进程 cwd（工作区）里找不到 tsx。
 */
function resolveHostEntry(): HostEntry {
  const here = fileURLToPath(import.meta.url)
  const dir = path.dirname(here)
  const compiled = path.join(dir, "sandbox-host.js")
  if (existsSync(compiled)) return { script: compiled, execArgv: [] }
  const source = path.join(dir, "sandbox-host.ts")
  const require = createRequire(import.meta.url)
  // tsx 的 loader.mjs 可直接作为 --import 目标
  const loader = require.resolve("tsx")
  return { script: source, execArgv: ["--import", loader] }
}

function capOutput(chunks: Buffer[], total: number): { text: string; truncated: boolean } {
  const joined = Buffer.concat(chunks)
  if (joined.length <= MAX_OUTPUT_BYTES) return { text: joined.toString("utf8"), truncated: false }
  return { text: joined.subarray(0, MAX_OUTPUT_BYTES).toString("utf8"), truncated: true }
}

function blocked(reason: string): SandboxCommandResult {
  return { exitCode: null, stdout: "", stderr: "", blocked: true, blockReason: reason }
}

export interface SrtExecutorOptions {
  /** 平台覆盖（测试用） */
  platform?: NodeJS.Platform
  /** Host 入口覆盖（测试用） */
  hostEntry?: HostEntry
}

export class SrtCommandExecutor implements CommandExecutor {
  constructor(private readonly options: SrtExecutorOptions = {}) {}

  async execute(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    if (!sandboxPlatformSupported(this.options.platform ?? process.platform)) {
      // M2.5：明确不支持，绝不退回宿主执行
      return blocked(
        `isolation_unavailable：平台 ${this.options.platform ?? process.platform} 无受支持的 OS 级隔离后端（Windows 需 WSL2/Docker 方案，另行评估）`,
      )
    }
    if (!request.command.trim()) return blocked("empty_command")
    if (request.signal?.aborted) {
      return { exitCode: null, stdout: "", stderr: "", blocked: true, blockReason: "aborted_before_start" }
    }

    const host = this.options.hostEntry ?? resolveHostEntry()
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const payload: SandboxHostPayload = {
      command: request.command,
      // 相对 cwd 按工作区解析，并转绝对路径：Host 直接以此为 spawn cwd（不用 process.chdir）
      cwd: path.resolve(request.cwd),
      policy: { workspace: request.cwd },
      commandId: request.toolCallId ?? request.executionId ?? `cmd-${Date.now()}`,
      commandText: request.command,
    }

    return await new Promise<SandboxCommandResult>((resolve) => {
      const out: Buffer[] = []
      const err: Buffer[] = []
      let violations: string[] = []
      let ready = false
      let settled = false
      let timedOut = false
      let aborted = false
      let stopReason: string | undefined

      const child = spawn(process.execPath, [...host.execArgv, host.script], {
        cwd: payload.cwd,
        // detached：Host 成为进程组长，kill(-pid) 才能终止整组（命令 + 派生进程）
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        windowsHide: true,
      })

      const control = child.stdio[3] as NodeJS.ReadableStream | null
      child.stdout?.on("data", (c: Buffer) => {
        if (out.reduce((n, b) => n + b.length, 0) < MAX_OUTPUT_BYTES) out.push(c)
      })
      child.stderr?.on("data", (c: Buffer) => {
        if (err.reduce((n, b) => n + b.length, 0) < MAX_OUTPUT_BYTES) err.push(c)
      })

      let controlBuf = ""
      control?.on("data", (chunk: Buffer) => {
        controlBuf += chunk.toString("utf8")
        let idx: number
        while ((idx = controlBuf.indexOf("\n")) >= 0) {
          const line = controlBuf.slice(0, idx).trim()
          controlBuf = controlBuf.slice(idx + 1)
          if (line === "ready") ready = true
          else if (line.startsWith("violations ")) {
            try {
              violations = JSON.parse(line.slice("violations ".length)) as string[]
            } catch {
              /* 归因解析失败不影响执行结果 */
            }
          } else if (line.startsWith("failed")) {
            stopReason = "isolation_unavailable"
          }
        }
      })

      /** 终止整个进程组（Host 是组长） */
      const killGroup = (signal: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, signal)
        } catch {
          try {
            child.kill(signal)
          } catch {
            /* 已退出 */
          }
        }
      }

      const onAbort = () => {
        aborted = true
        killGroup("SIGTERM")
        setTimeout(() => killGroup("SIGKILL"), STOP_GRACE_MS).unref()
      }
      request.signal?.addEventListener("abort", onAbort, { once: true })

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true
              killGroup("SIGTERM")
              setTimeout(() => killGroup("SIGKILL"), STOP_GRACE_MS).unref()
            }, timeoutMs)
          : undefined
      timer?.unref()

      const settle = (exitCode: number | null) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        request.signal?.removeEventListener("abort", onAbort)
        const stdout = capOutput(out, 0)
        const stderr = capOutput(err, 0)
        const stderrParts = [stderr.text]
        if (stderr.truncated) stderrParts.push("[stderr 超限已截断]")
        if (violations.length) stderrParts.push(`[sandbox violations]\n${violations.join("\n")}`)
        if (!ready && stopReason === "isolation_unavailable") {
          resolve(blocked("isolation_unavailable：沙盒初始化失败（SRT 依赖缺失或平台后端不可用），命令未执行"))
          return
        }
        resolve({
          exitCode: aborted || timedOut ? null : exitCode,
          stdout: stdout.text + (stdout.truncated ? "\n[stdout 超限已截断]" : ""),
          stderr: stderrParts.filter(Boolean).join("\n"),
          ...(timedOut ? { timedOut: true } : {}),
          ...(aborted ? { blocked: true as const, blockReason: "aborted" } : {}),
        })
      }

      child.once("error", () => settle(null))
      child.once("exit", (code) => {
        // Host 退出后其管道可能仍有残余数据：等 stdio 关闭再结算（drain）
        const drain = () => settle(code)
        if (child.stdout?.readableEnded && child.stderr?.readableEnded) drain()
        else child.once("close", drain)
      })
    })
  }
}
