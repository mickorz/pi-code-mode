/**
 * Sandbox Host —— 一条命令一个独立进程（M2.1）
 *
 * 为什么必须独立进程：SRT 的 SandboxManager 是模块级单例（配置、代理、运行时资源都挂在
 * 模块状态上）。同一进程里包裹两条不同权限的命令会互相污染——后初始化的配置对所有命令生效。
 * 一个 Host 进程 = 一份独立 SRT Runtime = 一份独立 allowlist 与代理。
 * （PiBot 实测结论，见 dev-docs/research/2026-11-24-pibot-sandbox-permission-research.md）
 *
 * 协议（与 srt-executor.ts 配对）：
 *   stdin  : 一行 JSON payload（SandboxHostPayload），写完后保持打开作为父进程存活信号
 *   fd 3   : 控制通道，Host -> 父进程，逐行文本
 *              "ready"                    命令已 spawn，开始执行
 *              "failed <code>"            沙盒初始化/包裹失败（不执行命令）
 *              "violations <json>"        沙盒拦截事件（退出前上报）
 *              "exit <code|signal>"       命令结束
 *   stdout : 命令的 stdout（原样转发给父进程）
 *   stderr : 命令的 stderr + 沙盒诊断
 *
 * 生命周期（评审要求的第一处细节）：SRT 的 abortSignal 只覆盖"包裹阶段"，
 * 真正运行中的子进程必须由 Host 自己负责：
 *   父进程死 / stdin EOF -> kill 整个进程组 -> 等子进程退出 -> drain -> SRT reset -> 退出
 * 绝不留孤儿进程。
 */

import { spawn, spawnSync } from "node:child_process"
import { writeSync } from "node:fs"
import { createInterface } from "node:readline"
import { SandboxManager } from "@anthropic-ai/sandbox-runtime"
import { buildSandboxConfig, sandboxPlatformSupported, type SandboxPolicyInput } from "./sandbox-config.js"

/** payload 上限：防御异常大的命令文本把 Host 内存打爆 */
export const SANDBOX_PAYLOAD_BYTES = 256 * 1024
/** 停止时给命令的宽限期（SIGTERM -> SIGKILL） */
const STOP_GRACE_MS = 3000

export interface SandboxHostPayload {
  command: string
  cwd: string
  /** 可写边界与网络白名单 */
  policy: SandboxPolicyInput
  /** 相关标识（SRT 违规归因用，必须唯一） */
  commandId: string
  /** 面向人的命令文本（SRT 上报用） */
  commandText: string
  /** 解释器（缺省 /bin/bash） */
  shell?: string
}

/** 写 fd 3（同步写：快速命令可能在 ready 之后立刻退出，异步写会丢行） */
function report(line: `ready` | `failed ${number}` | `violations ${string}` | `exit ${string}`): void {
  try {
    writeSync(3, `${line}\n`)
  } catch {
    // 父进程已关闭控制通道（已 abort 或已退出）；退出码仍能表达结果
  }
}

function exitWith(code: number, signal?: NodeJS.Signals): never {
  if (signal) {
    // 与未包裹的命令保持一致的终止语义：signalled 命令报 signal 而非 128+n
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
  }
  process.exit(code)
}

/** 进程组内除自己以外的存活成员数（用于确认无孤儿） */
function groupMemberCount(): number {
  if (process.platform === "win32") return 0
  const ps = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: 2000 })
  if (ps.status !== 0) return 0
  let count = 0
  for (const line of ps.stdout.split("\n")) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number)
    if (pgid === process.pid && pid !== process.pid && ppid !== process.pid) count++
  }
  return count
}

async function main(): Promise<void> {
  // 信号：让组内 SIGTERM 到达命令自身，Host 继续存活直到命令结束以便回收与上报
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => {})

  const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
  let inputBytes = 0
  process.stdin.on("data", (chunk: Buffer) => {
    inputBytes += chunk.length
    if (inputBytes > SANDBOX_PAYLOAD_BYTES + 16) {
      report("failed 126")
      rl.close()
      process.stdin.destroy()
      killGroup()
    }
  })

  const first = await new Promise<string | undefined>((resolve) => {
    rl.once("line", resolve)
    rl.once("close", () => resolve(undefined))
  })
  if (!first) return exitWith(126)

  // 父进程关闭 stdin = 父进程死了或主动停止：不留孤儿沙盒
  let stopping = false
  const killGroup = (): void => {
    if (stopping) return
    stopping = true
    try {
      process.kill(-process.pid, "SIGTERM")
    } catch {
      // 组已空
    }
    setTimeout(() => {
      try {
        process.kill(-process.pid, "SIGKILL")
      } catch {
        process.exit(137)
      }
    }, STOP_GRACE_MS).unref()
  }
  process.stdin.once("end", killGroup)
  process.stdin.once("close", killGroup)

  if (!sandboxPlatformSupported()) {
    // 平台不支持：拒绝执行，绝不降级宿主执行
    report("failed 125")
    return exitWith(125)
  }

  let payload: SandboxHostPayload
  try {
    payload = JSON.parse(first) as SandboxHostPayload
    if (!payload?.command || !payload?.cwd || !payload?.policy?.workspace) throw new Error("bad payload")
  } catch {
    report("failed 126")
    return exitWith(126)
  }

  const shell = payload.shell ?? "/bin/bash"
  const config = buildSandboxConfig(payload.policy)

  try {
    await SandboxManager.initialize(config, undefined, false)
    const wrapped = await SandboxManager.wrapWithSandbox(payload.command, shell, config, undefined, {
      commandId: payload.commandId,
      commandText: payload.commandText,
    })
    if (stopping) return exitWith(125)
    // 命令与 Host 同进程组（Host 是组长），父进程 kill(-hostPid) 即终止整组
    const child = spawn(shell, ["--noprofile", "--norc", "-c", wrapped], {
      cwd: payload.cwd,
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    })
    child.once("error", () => {
      report("failed 125")
      void finish(125)
    })
    child.once("spawn", () => report("ready"))
    child.once("exit", (code, signal) => {
      void finish(code ?? 1, signal ?? undefined)
    })
  } catch {
    // 细节可能含工作区路径：父进程统一报 isolation_unavailable
    report("failed 125")
    return exitWith(125)
  }

  let finished = false
  async function finish(code: number, signal?: NodeJS.Signals): Promise<void> {
    if (finished) return
    finished = true
    // 上报沙盒拦截（代理拒绝只存在于本 Host 的 SRT store 里，输出被管道化时不取就永久丢失）
    try {
      const lines = SandboxManager.getSandboxViolationStore()
        .getViolations()
        .map((v) => v.line)
        .filter((line) => line.startsWith("deny "))
      if (lines.length) report(`violations ${JSON.stringify(lines.slice(0, 50))}`)
    } catch {
      // 归因失败不影响退出语义
    }
    // 等组内残留进程收尾（`server &` 这类命令会留下后台进程）
    if (process.platform !== "win32") {
      const deadline = Date.now() + STOP_GRACE_MS
      while (groupMemberCount() > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
      }
      if (groupMemberCount() > 0) {
        try {
          process.kill(-process.pid, "SIGKILL")
        } catch {
          /* 已空 */
        }
      }
    }
    report(`exit ${signal ?? code}`)
    try {
      SandboxManager.cleanupAfterCommand()
      // reset 卡住也不能让 Host 常驻（代理随进程消失）
      await Promise.race([SandboxManager.reset().catch(() => undefined), new Promise((r) => setTimeout(r, 2000))])
    } catch {
      /* 清理失败不改变命令本身的退出结果 */
    }
    exitWith(code, signal)
  }
}

void main().catch(() => {
  report("failed 125")
  process.exit(125)
})
