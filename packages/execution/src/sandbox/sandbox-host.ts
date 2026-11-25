/**
 * Sandbox Host —— 一条命令一个独立进程（M2.1，SRT >= 0.0.83）
 *
 * 为什么必须独立进程：SRT 的 SandboxManager 是模块级单例（配置、代理、运行时资源都挂在
 * 模块状态上）。同一进程里包裹两条不同权限的命令会互相污染——后初始化的配置对所有命令生效。
 * 一个 Host 进程 = 一份独立 SRT Runtime = 一份独立 allowlist 与代理。
 *
 * 用 spawnSandboxed（0.0.83）而不是 wrapWithSandbox + 自己 spawn：
 *   它原生提供 kill()（杀命令及其派生的全部进程）、wait()（exitCode + timedOut）、
 *   timeoutMs（内建超时）——比手写进程组管理更可靠，平台差异由 SRT 内部消化。
 *
 * 协议（与 srt-executor.ts 配对）：
 *   stdin  : 一行 JSON payload（SandboxHostPayload），写完后保持打开作为父进程存活信号
 *   fd 3   : 控制通道，Host -> 父进程，逐行文本
 *              "ready"                    命令已 spawn，开始执行
 *              "failed <code>"            沙盒初始化/包裹失败（不执行命令）
 *              "violations <json>"        沙盒拦截事件（退出前上报）
 *              "exit <code|timeout>"
 *   stdout : 命令 stdout（原样转发）
 *   stderr : 命令 stderr + 沙盒诊断
 *
 * 生命周期：父进程死 / stdin EOF -> kill 整棵进程树 -> wait -> drain -> SRT reset -> 退出。
 */

import { writeSync } from "node:fs"
import { createInterface } from "node:readline"
import { SandboxManager, type SandboxedProcess } from "@anthropic-ai/sandbox-runtime"
import { buildSandboxConfig, sandboxPlatformSupported, type SandboxPolicyInput } from "./sandbox-config.js"

/** payload 上限：防御异常大的命令文本把 Host 内存打爆 */
export const SANDBOX_PAYLOAD_BYTES = 256 * 1024

export interface SandboxHostPayload {
  command: string
  cwd: string
  /** 可写边界与网络白名单 */
  policy: SandboxPolicyInput
  /** SRT 违规归因键（必须唯一） */
  commandId: string
  /** 面向人的命令文本（SRT 上报用） */
  commandText: string
  /** 解释器；缺省由 SRT 按平台决定（Windows: cmd.exe） */
  shell?: string
  /** 命令超时（毫秒）；0/缺省 = 仅由父进程控制 */
  timeoutMs?: number
}

/** 阶段追踪（PCM_SANDBOX_DEBUG=1 时打到 stderr，不影响控制通道） */
function trace(stage: string): void {
  if (process.env.PCM_SANDBOX_DEBUG === "1") {
    try {
      process.stderr.write(`[host] ${stage}
`)
    } catch {
      /* 忽略 */
    }
  }
}

/** 写 fd 3（同步写：快速命令可能在 ready 之后立刻退出，异步写会丢行） */
function report(line: string): void {
  try {
    writeSync(3, `${line}\n`)
  } catch {
    // 父进程已关闭控制通道（已 abort 或已退出）；退出码仍能表达结果
  }
}

async function main(): Promise<void> {
  // 让组内 SIGTERM 到达命令自身；Host 存活到命令收尾以便上报与清理
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => {})

  const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
  let inputBytes = 0
  process.stdin.on("data", (chunk: Buffer) => {
    inputBytes += chunk.length
    if (inputBytes > SANDBOX_PAYLOAD_BYTES + 16) {
      report("failed 126")
      rl.close()
      process.stdin.destroy()
    }
  })

  const first = await new Promise<string | undefined>((resolve) => {
    rl.once("line", resolve)
    rl.once("close", () => resolve(undefined))
  })
  if (!first) process.exit(126)

  // 父进程关闭 stdin = 父进程死了或主动停止：不留孤儿沙盒
  let proc: SandboxedProcess | undefined
  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    try {
      proc?.kill()
    } catch {
      /* 已退出 */
    }
  }
  process.stdin.once("end", stop)
  process.stdin.once("close", stop)

  // 平台守卫：本项目承诺只为 darwin/linux（及启用后的 win32 srt-win）背书
  if (!sandboxPlatformSupported() && !payloadAllowsWindows(first)) {
    report("failed 125")
    process.exit(125)
  }

  let payload: SandboxHostPayload
  try {
    payload = JSON.parse(first) as SandboxHostPayload
    if (!payload?.command || !payload?.cwd || !payload?.policy?.workspace) throw new Error("bad payload")
  } catch {
    report("failed 126")
    process.exit(126)
  }

  const config = buildSandboxConfig(payload.policy)
  trace(`payload ok, backend=${payload.policy.windowsBackend ?? "default"}`)

  try {
    trace("initialize start")
    await SandboxManager.initialize(config, undefined, false)
    trace(`initialize done backend=${JSON.stringify(SandboxManager.getWindowsBackend?.())}`)
    if (stopping) process.exit(125)
    trace("spawn start")
    proc = await SandboxManager.spawnSandboxed!(payload.command, {
      ...(payload.shell ? { binShell: payload.shell } : {}),
      cwd: payload.cwd,
      ...(payload.timeoutMs ? { timeoutMs: payload.timeoutMs } : {}),
      commandId: payload.commandId,
      commandText: payload.commandText,
    })
    proc.stdout?.on("data", (c: Buffer) => process.stdout.write(c))
    proc.stderr?.on("data", (c: Buffer) => process.stderr.write(c))
    trace(`spawned pid=${proc.pid}`)
    report("ready")
    const { exitCode, timedOut } = await proc.wait()
    trace(`wait done exit=${exitCode} timedOut=${timedOut}`)
    report(`exit ${timedOut ? "timeout" : exitCode}`)
    await cleanup()
    process.exit(timedOut ? 124 : exitCode)
  } catch (e) {
    // 细节可能含工作区路径：父进程统一报 isolation_unavailable
    trace(`failed: ${(e as Error)?.constructor?.name} ${(e as Error)?.message}`)
    report("failed 125")
    process.exit(125)
  }

  async function cleanup(): Promise<void> {
    try {
      const lines = SandboxManager.getSandboxViolationStore()
        .getViolations()
        .map((v: { line: string }) => v.line)
        .filter((line: string) => line.startsWith("deny "))
      if (lines.length) report(`violations ${JSON.stringify(lines.slice(0, 50))}`)
    } catch {
      // 归因失败不影响退出语义
    }
    try {
      proc?.dispose()
    } catch {
      /* 已释放 */
    }
    try {
      SandboxManager.cleanupAfterCommand()
      // reset 卡住也不能让 Host 常驻（代理随进程消失）
      await Promise.race([
        SandboxManager.reset().catch(() => undefined),
        new Promise((r) => setTimeout(r, 2000)),
      ])
    } catch {
      /* 清理失败不改变命令本身的退出结果 */
    }
  }
}

/** Windows 启用 srt-win 后允许 Host 在 win32 上运行（由 policy.windowsBackend 显式声明） */
function payloadAllowsWindows(rawPayload: string): boolean {
  if (process.platform !== "win32") return false
  try {
    const parsed = JSON.parse(rawPayload) as SandboxHostPayload
    return parsed?.policy?.windowsBackend === "srt-win" || parsed?.policy?.windowsBackend === "mxc"
  } catch {
    return false
  }
}

void main().catch(() => {
  report("failed 125")
  process.exit(125)
})
