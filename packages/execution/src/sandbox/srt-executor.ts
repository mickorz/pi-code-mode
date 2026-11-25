/**
 * SrtCommandExecutor —— CommandExecutor 的 SRT 实现
 *
 * 每条命令 spawn 一个独立 Sandbox Host 进程（见 sandbox-host.ts 的"为什么独立进程"）。
 *
 * 平台策略：
 *   darwin / linux        -> 支持（Seatbelt / bubblewrap+seccomp）
 *   win32                 -> **默认拒绝**（isolation_unavailable，绝不降级宿主执行）
 *   win32 + windowsBackend -> 显式 opt-in 后才走 srt-win 后端（M2-W0 可行性验证用；
 *                            需先完成系统级安装，未通过安全验收前不得作为默认）
 *   其他平台              -> 拒绝
 *
 * 取消语义：Host 是独立进程，abort/timeout 由父进程 kill 整组；
 * Host 内部用 SRT 的 spawnSandboxed().kill() 杀命令及其派生进程。
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mxcNodeVersionHint, mxcNodeVersionOk, sandboxPlatformSupported } from "./sandbox-config.js"
import { killProcessTree } from "./process-tree.js"
import type { SandboxHostPayload } from "./sandbox-host.js"
import type { CommandExecutor, SandboxCommandRequest, SandboxCommandResult } from "../command/types.js"

/** 停止宽限期：SIGTERM 后多久 SIGKILL 宿主 */
const STOP_GRACE_MS = 3000
/** 默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 120_000
/** 输出上限（每流，字节）：超限截断并标注 */
const MAX_OUTPUT_BYTES = 1024 * 1024

interface HostEntry {
  script: string
  execArgv: string[]
}

/**
 * 定位 Host 入口：优先同目录已编译 .js（发布产物）；开发态（jiti 直载 TS）退回 tsx 加载器。
 * 用绝对路径喂 --import，避免子进程 cwd（工作区）里找不到 tsx。
 */
function resolveHostEntry(): HostEntry {
  // import.meta.url 是自身文件 URL；转路径再取同目录
  const here = fileURLToPathLocal()
  const dir = path.dirname(here)
  const compiled = path.join(dir, "sandbox-host.js")
  if (existsSync(compiled)) return { script: compiled, execArgv: [] }
  // 开发态：--import 必须是 file:// URL（Node 26 下 Windows 绝对路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME）
  const loaderUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href
  return { script: path.join(dir, "sandbox-host.ts"), execArgv: ["--import", loaderUrl] }
}

function fileURLToPathLocal(): string {
  return fileURLToPath(import.meta.url)
}

function capOutput(chunks: Buffer[]): { text: string; truncated: boolean } {
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
  /**
   * Windows 后端显式 opt-in（SRT >= 0.0.83）。设置后才允许 win32 走 srt-win/mxc。
   * 缺省 undefined = Windows 保持 unsupported（fail-closed）。
   */
  windowsBackend?: "srt-win" | "mxc"
  /** Host 入口覆盖（测试用） */
  hostEntry?: HostEntry
}

export class SrtCommandExecutor implements CommandExecutor {
  constructor(private readonly options: SrtExecutorOptions = {}) {}

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform
  }

  private get enabled(): boolean {
    if (sandboxPlatformSupported(this.platform)) return true
    // Windows 仅在显式 opt-in 后启用（M2-W0 验证路径）
    return this.platform === "win32" && this.options.windowsBackend !== undefined
  }

  async execute(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    if (!this.enabled) {
      return blocked(
        `isolation_unavailable：平台 ${this.platform} 无受支持的 OS 级隔离后端（Windows 需先完成 srt-win 安装与 M2-W0 安全验收）`,
      )
    }
    // MXC 后端对 Node 版本有硬要求（原生 stdio）；提前拦截并给可操作信息
    if (this.options.windowsBackend === "mxc" && !mxcNodeVersionOk()) {
      return blocked(`isolation_unavailable：${mxcNodeVersionHint()}`)
    }
    if (!request.command.trim()) return blocked("empty_command")
    if (request.signal?.aborted) return blocked("aborted_before_start")

    const host = this.options.hostEntry ?? resolveHostEntry()
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const payload: SandboxHostPayload = {
      command: request.command,
      cwd: path.resolve(request.cwd),
      policy: {
        workspace: request.cwd,
        ...(this.options.windowsBackend ? { windowsBackend: this.options.windowsBackend } : {}),
        ...(request.denyWorkspaces?.length ? { denyWorkspaces: request.denyWorkspaces } : {}),
        ...(request.allowedDomains?.length ? { allowedDomains: request.allowedDomains } : {}),
      },
      commandId: request.toolCallId ?? request.executionId ?? `cmd-${Date.now()}`,
      commandText: request.command,
      timeoutMs,
    }

    return await new Promise<SandboxCommandResult>((resolve) => {
      const out: Buffer[] = []
      const err: Buffer[] = []
      let violations: string[] = []
      let ready = false
      let settled = false
      let timedOut = false
      let aborted = false
      let failedInit = false

      const child = spawn(process.execPath, [...host.execArgv, host.script], {
        cwd: payload.cwd,
        // detached：Host 成为进程组长，kill(-pid) 终止整组（Host + 命令 + 派生进程）
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        windowsHide: true,
      })

      const control = child.stdio[3] as NodeJS.ReadableStream | null
      // 投递 payload（单行 JSON）；stdin 保持打开作为 Host 的存活信号，
      // 父进程异常退出时 Host 读到 EOF 会杀整棵进程树。
      child.stdin?.once("error", () => {
        /* Host 提前退出：由 exit 事件结算 */
      })
      child.stdin?.write(`${JSON.stringify(payload)}\n`)
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
          } else if (line.startsWith("failed")) failedInit = true
          else if (line === "exit timeout") timedOut = true
        }
      })

      // 平台感知终止（M2-W0c）：POSIX 杀进程组；Windows 用 taskkill /T /F 杀整棵树。
      // Windows 无负 PID 语义，原先的 process.kill(-pid) 在这里是空操作。
      const killGroup = (force: boolean) => {
        if (!child.pid) return
        const ok = killProcessTree(child.pid, { force })
        if (!ok) {
          try {
            child.kill()
          } catch {
            /* 已退出 */
          }
        }
      }

      const onAbort = () => {
        aborted = true
        killGroup(false) // 先优雅
        setTimeout(() => killGroup(true), STOP_GRACE_MS).unref() // 宽限后强杀
      }
      request.signal?.addEventListener("abort", onAbort, { once: true })

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true
              killGroup(false)
              setTimeout(() => killGroup(true), STOP_GRACE_MS).unref()
            }, timeoutMs + 5000) // Host 内部有自己的 timeoutMs，父进程留 5s 余量兜底
          : undefined
      timer?.unref()

      const settle = (exitCode: number | null) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        request.signal?.removeEventListener("abort", onAbort)
        if (!ready && failedInit) {
          resolve(
            blocked(
              "isolation_unavailable：沙盒初始化失败（SRT 依赖缺失、平台后端未安装或配置被拒），命令未执行",
            ),
          )
          return
        }
        const stdout = capOutput(out)
        const stderr = capOutput(err)
        const stderrParts = [stderr.text]
        if (stderr.truncated) stderrParts.push("[stderr 超限已截断]")
        if (violations.length) stderrParts.push(`[sandbox violations]\n${violations.join("\n")}`)
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
        // Host 退出后管道可能仍有残余：等 stdio 关闭再结算（drain）
        if (child.stdout?.readableEnded && child.stderr?.readableEnded) settle(code)
        else child.once("close", () => settle(code))
      })
    })
  }
}
