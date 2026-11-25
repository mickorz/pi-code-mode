/**
 * Sandbox Host —— 一条命令一个独立进程（M2.1 + M2-W0c 加固）
 *
 * 为什么必须独立进程：SRT 的 SandboxManager 是模块级单例（配置、代理、运行时资源都挂在
 * 模块状态上）。同一进程里包裹两条不同权限的命令会互相污染——后初始化的配置对所有命令生效。
 * 一个 Host 进程 = 一份独立 SRT Runtime = 一份独立 allowlist 与代理。
 *
 * TEMP 隔离（M2-W0c）：SRT 的 buildMxcRequest() 无条件把**宿主机 %TEMP%** 加入可写路径
 * （mxc-sandbox-utils.ts，readwritePaths 尾部 `temp !== undefined ? [temp] : []`）。
 * 若所有 Host 共用宿主机 TEMP，则不同工作区的沙盒共享一块可写区域。
 * 解法：Host 启动后先把自身 process.env.TEMP/TMP 指向一个随机私有目录，再 initialize，
 * 让 SRT 按该目录生成写授权；Host 退出时删除它。宿主机原 TEMP 因此不再进入授权列表。
 *
 * 取消与回收（M2-W0c，Windows 关键）：
 *   - 信号：真杀 proc（不再空实现）
 *   - stdin EOF（父进程死）：真杀 proc
 *   - spawn 竞争：spawnSandboxed 返回后**再次检查 stopping**，避免"停在前、spawn 在后"漏杀
 *
 * 协议（与 srt-executor.ts 配对）：
 *   stdin  : 一行 JSON payload；保持打开作为存活信号
 *   fd 3   : "ready" | "failed <code>" | "violations <json>" | "exit <code|timeout>"
 *   stdout/stderr：命令输出原样转发
 */

import { mkdtempSync, rmSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { SandboxManager, type SandboxedProcess } from "@anthropic-ai/sandbox-runtime"
import { buildSandboxConfig, sandboxPlatformSupported, type SandboxPolicyInput } from "./sandbox-config.js"

/** payload 上限：防御异常大的命令文本 */
export const SANDBOX_PAYLOAD_BYTES = 256 * 1024

export interface SandboxHostPayload {
  command: string
  cwd: string
  policy: SandboxPolicyInput
  commandId: string
  commandText: string
  shell?: string
  timeoutMs?: number
}

/** 阶段追踪（PCM_SANDBOX_DEBUG=1 打到 stderr，不进控制通道） */
function trace(stage: string): void {
  if (process.env.PCM_SANDBOX_DEBUG === "1") {
    try {
      process.stderr.write(`[host] ${stage}\n`)
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
    // 父进程已关闭控制通道；退出码仍能表达结果
  }
}

async function main(): Promise<void> {
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

  let payload: SandboxHostPayload
  try {
    payload = JSON.parse(first) as SandboxHostPayload
    if (!payload?.command || !payload?.cwd || !payload?.policy?.workspace) throw new Error("bad payload")
  } catch {
    report("failed 126")
    process.exit(126)
  }

  // 平台守卫：darwin/linux 恒允许；win32 仅在显式指定后端时允许
  const winBackend = payload.policy.windowsBackend
  if (!sandboxPlatformSupported() && !(process.platform === "win32" && winBackend)) {
    report("failed 125")
    process.exit(125)
  }

  let proc: SandboxedProcess | undefined
  let stopping = false
  let tempHome: string | undefined

  /** 真正的终止：杀 Host 自己的 SRT 子进程（不再依赖信号处理器空实现） */
  const stop = (reason: string): void => {
    if (stopping) return
    stopping = true
    trace(`stop requested (${reason})`)
    try {
      proc?.kill()
    } catch {
      /* 已退出 */
    }
    try {
      if (proc?.pid) {
        // 二次兜底：MXC 的 kill() 应已覆盖整棵树；此处只在本平台有 group 语义时补刀
        if (process.platform !== "win32") process.kill(-process.pid, "SIGKILL")
      }
    } catch {
      /* 组已空 */
    }
  }

  // 信号：真终止（POSIX 上父进程通常发组信号；Windows 由父进程 taskkill 树）
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      stop(`signal ${sig}`)
      // 给 SRT 收尾一点时间；父进程会兜底强杀
      setTimeout(() => process.exit(143), 1500).unref()
    })
  }
  // 父进程关闭 stdin = 父进程死了或主动停止
  process.stdin.once("end", () => stop("stdin end"))
  process.stdin.once("close", () => stop("stdin close"))

  // ── TEMP 隔离：把本 Host 的 TEMP 指向私有目录，SRT 据此生成写授权 ──
  try {
    tempHome = mkdtempSync(path.join(tmpdir(), `pcm-host-temp-${process.pid}-`))
    process.env.TEMP = tempHome
    process.env.TMP = tempHome
    process.env.TMPDIR = tempHome
    trace(`temp isolated: ${tempHome}`)
  } catch {
    trace("temp isolation failed (继续，但宿主 TEMP 会进入可写授权)")
  }

  const config = buildSandboxConfig(payload.policy)
  trace(`payload ok, backend=${winBackend ?? "default"}`)

  try {
    trace("initialize start")
    await SandboxManager.initialize(config, undefined, false)
    trace(`initialize done backend=${JSON.stringify(SandboxManager.getWindowsBackend?.())}`)

    // 竞争窗口防护（W0c）：initialize 期间可能已被要求停止
    if (stopping) {
      await cleanup()
      process.exit(125)
    }

    trace("spawn start")
    proc = await SandboxManager.spawnSandboxed!(payload.command, {
      ...(payload.shell ? { binShell: payload.shell } : {}),
      cwd: payload.cwd,
      ...(payload.timeoutMs ? { timeoutMs: payload.timeoutMs } : {}),
      commandId: payload.commandId,
      commandText: payload.commandText,
    })
    trace(`spawned pid=${proc.pid}`)

    // **关键**：spawn 返回后再次检查 stopping —— 若停止请求早于 proc 赋值，
    // 上面的 stop() 是空转，这里必须补杀，否则留下孤儿命令。
    if (stopping) {
      trace("stopping after spawn -> kill immediately")
      try {
        proc.kill()
      } catch {
        /* 已退出 */
      }
      await proc.wait().catch(() => undefined)
      await cleanup()
      process.exit(125)
    }

    proc.stdout?.on("data", (c: Buffer) => process.stdout.write(c))
    proc.stderr?.on("data", (c: Buffer) => process.stderr.write(c))
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
    await cleanup()
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
      /* 归因失败不影响退出语义 */
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
      /* 清理失败不改变命令退出结果 */
    }
    // 删除本 Host 的私有 TEMP（命令已退出；残留由 OS temp 清理兜底）
    if (tempHome) {
      try {
        rmSync(tempHome, { recursive: true, force: true })
      } catch {
        /* 文件占用时留给 OS 清理 */
      }
    }
  }
}

void main().catch(() => {
  report("failed 125")
  process.exit(125)
})
