/**
 * ControlPlaneExecutor —— 受控执行面（M2-W4，路线 A）
 *
 * 背景（M2-W3b 实测）：GUI Electron 应用（CocosCreator）无法在 MXC BaseContainer 内启动，
 * 因此 `cocoscli build` 这类 GUI 构建链不能作为沙盒内命令。本执行器提供**显式、可审批、可审计**
 * 的宿主执行通道，只服务于这类"沙盒物理上无法承载"的命令。
 *
 * 四条硬约束（不可放宽）：
 *   1. **分类不由模型决定**：只有 Runtime 配置的 `allow` 模式命中的命令才走本通道，
 *      模型无法在参数里声明"请用控制面执行"。
 *   2. **必须显式审批**：`approve` 缺省 = 一律拒绝（headless/print 模式 fail-closed）。
 *   3. **全程审计**：每次请求（含被拒）都回调 `onAudit`，只记事实不记内容。
 *   4. **绝不静默降级**：沙盒执行失败不会自动转本通道；路由在调用前就已确定
 *      （见 RoutedCommandExecutor），失败即失败。
 */

import { spawn } from "node:child_process"
import path from "node:path"
import { killProcessTree } from "../sandbox/process-tree.js"
import type { CommandExecutor, SandboxCommandRequest, SandboxCommandResult } from "./types.js"

const STOP_GRACE_MS = 3000
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const MAX_OUTPUT_BYTES = 1024 * 1024

export interface ControlPlaneRule {
  /** 命令前缀或正则（Runtime/项目配置；不得来自模型输入） */
  match: string | RegExp
  /** 人类可读的理由（进审计，说明为什么必须在宿主执行） */
  reason: string
}

export interface ControlPlaneAuditEvent {
  at: number
  command: string
  cwd: string
  rule?: string
  decision: "approved" | "denied"
  denyReason?: string
  exitCode?: number | null
  timedOut?: boolean
  durationMs?: number
  runId?: string
  executionId?: string
  toolCallId?: string
}

export interface ControlPlaneOptions {
  /** 允许在控制面执行的命令规则；空数组 = 全部拒绝 */
  allow?: readonly ControlPlaneRule[]
  /**
   * 审批回调。返回 true 才执行。
   * 缺省未提供 → 所有请求拒绝（headless 场景必须 fail-closed）。
   */
  approve?: (info: {
    command: string
    cwd: string
    reason: string
    request: SandboxCommandRequest
  }) => Promise<boolean>
  /** 审计出口（每条请求都回调，含被拒） */
  onAudit?: (event: ControlPlaneAuditEvent) => void
  platform?: NodeJS.Platform
}

function matches(rule: ControlPlaneRule, command: string): boolean {
  if (rule.match instanceof RegExp) return rule.match.test(command)
  return command.includes(rule.match)
}

function cap(chunks: Buffer[]): { text: string; truncated: boolean } {
  const joined = Buffer.concat(chunks)
  if (joined.length <= MAX_OUTPUT_BYTES) return { text: joined.toString("utf8"), truncated: false }
  return { text: joined.subarray(0, MAX_OUTPUT_BYTES).toString("utf8"), truncated: true }
}

export class ControlPlaneExecutor implements CommandExecutor {
  constructor(private readonly options: ControlPlaneOptions = {}) {}

  /** 该命令是否属于控制面（由 Runtime 规则决定，模型无权干预） */
  match(command: string): ControlPlaneRule | undefined {
    return (this.options.allow ?? []).find((rule) => matches(rule, command))
  }

  async execute(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    const rule = this.match(request.command)
    const audit = (event: Partial<ControlPlaneAuditEvent> & Pick<ControlPlaneAuditEvent, "decision">) =>
      this.options.onAudit?.({
        at: Date.now(),
        command: request.command,
        cwd: request.cwd,
        runId: request.runId,
        executionId: request.executionId,
        toolCallId: request.toolCallId,
        ...(rule ? { rule: rule.reason } : {}),
        ...event,
      })

    if (!rule) {
      const denyReason = "not_in_control_plane_allowlist"
      audit({ decision: "denied", denyReason })
      return {
        exitCode: null,
        stdout: "",
        stderr: "",
        blocked: true,
        blockReason: `control_plane_denied：该命令不在受控执行面白名单内（${denyReason}），且沙盒无法承载`,
      }
    }

    // 审批：per-call 回调（受控工具注入，含 UI）优先，其次宿主配置的回调；
    // 两者都没有 → 拒绝（headless fail-closed）。
    const approver = request.approve ?? this.options.approve
    let approved = false
    if (approver) {
      try {
        approved = await approver({ command: request.command, cwd: request.cwd, reason: rule.reason, request })
      } catch {
        approved = false
      }
    }
    if (!approved) {
      const denyReason = approver ? "not_approved" : "no_approval_channel"
      audit({ decision: "denied", denyReason })
      return {
        exitCode: null,
        stdout: "",
        stderr: "",
        blocked: true,
        blockReason: `control_plane_denied：${denyReason}（受控执行面需要显式人工审批）`,
      }
    }

    if (request.signal?.aborted) {
      audit({ decision: "denied", denyReason: "aborted_before_start" })
      return { exitCode: null, stdout: "", stderr: "", blocked: true, blockReason: "aborted_before_start" }
    }

    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const started = Date.now()
    const result = await this.spawnOnHost(request, timeoutMs)
    audit({
      decision: "approved",
      exitCode: result.exitCode,
      ...(result.timedOut ? { timedOut: true } : {}),
      durationMs: Date.now() - started,
    })
    return result
  }

  /** 宿主执行：进程树可终止（Windows taskkill /T /F），输出有上限 */
  private spawnOnHost(request: SandboxCommandRequest, timeoutMs: number): Promise<SandboxCommandResult> {
    return new Promise((resolve) => {
      const isWin = (this.options.platform ?? process.platform) === "win32"
      const shell = isWin ? process.env.ComSpec ?? "cmd.exe" : "/bin/bash"
      const args = isWin ? ["/d", "/s", "/c", request.command] : ["-lc", request.command]

      const child = spawn(shell, args, {
        cwd: path.resolve(request.cwd),
        detached: !isWin, // POSIX：独立进程组便于整组终止；Windows 靠 taskkill /T
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: process.env,
      })

      const out: Buffer[] = []
      const err: Buffer[] = []
      let settled = false
      let timedOut = false
      let aborted = false

      child.stdout?.on("data", (c: Buffer) => {
        if (out.reduce((n, b) => n + b.length, 0) < MAX_OUTPUT_BYTES) out.push(c)
      })
      child.stderr?.on("data", (c: Buffer) => {
        if (err.reduce((n, b) => n + b.length, 0) < MAX_OUTPUT_BYTES) err.push(c)
      })

      const kill = (force: boolean) => {
        if (child.pid) killProcessTree(child.pid, { force, platform: this.options.platform ?? process.platform })
      }

      const onAbort = () => {
        aborted = true
        kill(false)
        setTimeout(() => kill(true), STOP_GRACE_MS).unref()
      }
      request.signal?.addEventListener("abort", onAbort, { once: true })

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true
              kill(false)
              setTimeout(() => kill(true), STOP_GRACE_MS).unref()
            }, timeoutMs)
          : undefined
      timer?.unref()

      const settle = (code: number | null) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        request.signal?.removeEventListener("abort", onAbort)
        const stdout = cap(out)
        const stderr = cap(err)
        resolve({
          exitCode: aborted || timedOut ? null : code,
          stdout: stdout.text + (stdout.truncated ? "\n[stdout 超限已截断]" : ""),
          stderr: stderr.text + (stderr.truncated ? "\n[stderr 超限已截断]" : ""),
          ...(timedOut ? { timedOut: true } : {}),
          ...(aborted ? { blocked: true as const, blockReason: "aborted" } : {}),
        })
      }

      child.once("error", (e) => {
        err.push(Buffer.from(`spawn_failed: ${e.message}`))
        settle(null)
      })
      child.once("exit", (code) => {
        if (child.stdout?.readableEnded && child.stderr?.readableEnded) settle(code)
        else child.once("close", () => settle(code))
      })
    })
  }
}
