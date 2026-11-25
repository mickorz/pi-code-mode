/**
 * Windows 侧完整验证（无 Mac 环境时的当前平台交付验收）
 *
 * 本项目 Windows 策略：explicit unsupported，绝不降级宿主机执行。
 * 因此 Windows 上的验收目标不是"沙盒能跑命令"，而是证明**每一条路径都拒绝，且零宿主执行**。
 *
 * 验证项：
 *   W1  工厂：win32 -> UnavailableCommandExecutor
 *   W2  工厂输出：blocked=isolation_unavailable，stdout 空
 *   W3  SrtCommandExecutor(win32)：短路上拒绝，不 spawn 任何进程
 *   W4  Host 进程协议：payload -> fd3 "failed 125" -> 退出 125 -> 命令零执行
 *   W5  配置基线（跨平台同源生成，Windows 也需正确）：凭据 denyRead / 网络全拒 / 写边界唯一
 *   W6  Adapter 端到端：run_command 被 fail-closed，磁盘无副作用
 *   W7  安全不变量：任何路径都不产生宿主机执行痕迹
 *   W8  信息：SRT Windows Alpha 后端就绪状态（只读探测，不修改系统）
 *
 * 用法：npx tsx windows-check.ts
 */
import { spawn, execFile } from "node:child_process"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import {
  buildSandboxConfig,
  createCommandExecutor,
  sandboxPlatformSupported,
  SrtCommandExecutor,
  UnavailableCommandExecutor,
} from "../../packages/execution/src/index.js"

const execFileAsync = promisify(execFile)
const results: Array<[string, boolean, string]> = []
const check = (id: string, ok: boolean, detail: string) => {
  results.push([id, ok, detail])
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  | ${detail}`)
}

async function main() {
  if (process.platform !== "win32") {
    console.log(`本脚本针对 Windows（当前 ${process.platform}）。macOS/Linux 请跑 m2-check.ts。`)
    process.exitCode = 2
    return
  }

  // ── W1/W2 工厂选择与输出 ──
  {
    const executor = createCommandExecutor()
    check("W1 工厂在 win32 返回拒绝实现", executor instanceof UnavailableCommandExecutor, `实际 ${executor.constructor.name}`)
    const r = await executor.execute({ command: "echo MUST_NOT_RUN", cwd: process.cwd() })
    check(
      "W2 工厂输出 isolation_unavailable 且零输出",
      r.blocked === true && r.exitCode === null && r.stdout === "" && !!r.blockReason?.includes("isolation_unavailable"),
      `blocked=${r.blocked} exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)} reason=${r.blockReason?.slice(0, 60)}`,
    )
  }

  // ── W3 SrtCommandExecutor 在 win32 短路上拒绝（不 spawn） ──
  {
    const executor = new SrtCommandExecutor({ platform: "win32" })
    const t0 = Date.now()
    const r = await executor.execute({ command: "echo MUST_NOT_RUN", cwd: process.cwd() })
    const elapsed = Date.now() - t0
    check(
      "W3 SrtExecutor(win32) 短路拒绝（毫秒级 = 未 spawn）",
      r.blocked === true && r.stdout === "" && elapsed < 1000,
      `blocked=${r.blocked} elapsed=${elapsed}ms stdout=${JSON.stringify(r.stdout)}`,
    )
  }

  // ── W4 Host 进程协议（真实 spawn Host，验证 fd3 失败通道） ──
  {
    const ws = await mkdtemp(path.join(os.tmpdir(), "pcm-win-host-"))
    try {
      const marker = path.join(ws, "marker.txt")
      const here = path.dirname(fileURLToPath(import.meta.url))
      const compiled = path.resolve(here, "../../dist/packages/execution/src/sandbox/sandbox-host.js")
      const source = path.resolve(here, "../../packages/execution/src/sandbox/sandbox-host.ts")
      const useCompiled = existsSync(compiled)
      const script = useCompiled ? compiled : source
      const execArgv = useCompiled ? [] : ["--import", createRequire(import.meta.url).resolve("tsx")]

      const child = spawn(process.execPath, [...execArgv, script], {
        cwd: ws,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        windowsHide: true,
      })
      const lines: string[] = []
      let buf = ""
      ;(child.stdio[3] as NodeJS.ReadableStream | null)?.on("data", (c: Buffer) => {
        buf += c.toString("utf8")
        let i: number
        while ((i = buf.indexOf("\n")) >= 0) {
          lines.push(buf.slice(0, i).trim())
          buf = buf.slice(i + 1)
        }
      })
      let stdout = ""
      child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")))
      child.stdin.write(
        JSON.stringify({
          command: `echo MUST_NOT_RUN > ${JSON.stringify(marker)}; echo MUST_NOT_RUN`,
          cwd: ws,
          policy: { workspace: ws },
          commandId: "win-check",
          commandText: "echo MUST_NOT_RUN",
        }) + "\n",
      )
      const code: number | null = await new Promise((res) => child.once("exit", (c) => res(c)))
      await new Promise((r) => setTimeout(r, 300))
      const onDisk = await readFile(marker, "utf8").catch(() => undefined)
      check(
        "W4 Host 协议：failed 125 + 命令零执行",
        code === 125 && lines.includes("failed 125") && onDisk === undefined && !stdout.includes("MUST_NOT_RUN"),
        `exit=${code} fd3=${JSON.stringify(lines)} marker=${onDisk === undefined ? "未创建" : "被创建(错误)"} stdout=${JSON.stringify(stdout)}`,
      )
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // ── W5 配置基线（Windows 上同样生成正确结构） ──
  {
    const cfg = buildSandboxConfig({ workspace: process.cwd() }) as unknown as {
      filesystem: { allowWrite: unknown[]; denyRead: Array<{ path: string }> }
      network: { allowedDomains: string[]; strictAllowlist?: boolean }
      credentials: { envVars: Array<{ name: string }> }
    }
    const credOk = cfg.filesystem.denyRead.some((p) => p.path.includes(".ssh")) && cfg.filesystem.denyRead.some((p) => p.path.includes(".aws"))
    check(
      "W5 配置基线（唯一写边界/凭据禁读/网络全拒/环境黑名单）",
      cfg.filesystem.allowWrite.length === 1 &&
        credOk &&
        cfg.network.allowedDomains.length === 0 &&
        cfg.network.strictAllowlist === true &&
        cfg.credentials.envVars.some((e) => e.name === "JAVA_TOOL_OPTIONS"),
      `writes=${cfg.filesystem.allowWrite.length} credDenies=${cfg.filesystem.denyRead.length} domains=${cfg.network.allowedDomains.length} envDenies=${cfg.credentials.envVars.length}`,
    )
  }

  // ── W6 Adapter 端到端（不调模型，直接构造受控扩展验证 fail-closed） ──
  {
    const { createPolicyExtension } = await import("../../packages/adapter/src/extensions/policy-extension.js")
    const { createAgentToolsExtension } = await import("../../packages/adapter/src/extensions/agent-tools.js")
    const { PermitStore } = await import("../../packages/policy-lite/src/index.js")
    const { WorkspaceFileService } = await import("../../packages/execution/src/index.js")

    const ws = await mkdtemp(path.join(os.tmpdir(), "pcm-win-adapter-"))
    try {
      const deps = {
        permits: new PermitStore(),
        files: new WorkspaceFileService(ws),
        executor: createCommandExecutor(),
        runId: "win-run",
        executionId: "win-exec",
      }
      const tools = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<unknown> }>()
      const handlers: Array<(e: unknown) => unknown> = []
      const fakePi = {
        registerTool: (t: { name: string; execute: (id: string, p: Record<string, unknown>) => Promise<unknown> }) =>
          tools.set(t.name, t),
        on: (_e: string, h: (e: unknown) => unknown) => handlers.push(h),
      }
      createPolicyExtension(deps)(fakePi as never)
      createAgentToolsExtension(deps)(fakePi as never)

      const event = { type: "tool_call", toolName: "run_command", toolCallId: "c1", input: { command: "echo MUST_NOT_RUN > pwned.txt" } }
      const verdict = handlers[0](event) as { block?: boolean } | undefined
      const out = (await tools.get("run_command")!.execute("c1", { command: "echo MUST_NOT_RUN > pwned.txt" })) as {
        content: Array<{ text: string }>
      }
      const pwned = await readFile(path.join(ws, "pwned.txt"), "utf8").catch(() => undefined)
      check(
        "W6 Adapter 链路 fail-closed（Policy allow 但执行层拒绝）",
        verdict === undefined && out.content[0].text.includes("isolation_unavailable") && pwned === undefined,
        `policyBlocked=${verdict?.block ?? false} toolText=${JSON.stringify(out.content[0].text.slice(0, 80))} 磁盘副作用=${pwned === undefined ? "无" : "有(错误)"}`,
      )

      // 危险命令应被第一阶段直接拦（不进入执行层）
      const danger = handlers[0]({ type: "tool_call", toolName: "run_command", toolCallId: "c2", input: { command: "rm -rf /" } }) as { block?: boolean; reason?: string }
      const dangerOut = (await tools.get("run_command")!.execute("c2", { command: "rm -rf /" })) as { content: Array<{ text: string }> }
      check(
        "W6b 危险命令第一阶段 block + 第二层 Permit 拒绝",
        danger.block === true && dangerOut.content[0].text.includes("permit denied"),
        `reason=${danger.reason} toolText=${JSON.stringify(dangerOut.content[0].text.slice(0, 50))}`,
      )
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  // ── W7 平台判定不变量 ──
  {
    check(
      "W7 win32 判定为不支持（不依赖 SRT 的 isSupportedPlatform）",
      sandboxPlatformSupported("win32") === false && sandboxPlatformSupported("darwin") && sandboxPlatformSupported("linux"),
      `win32=${sandboxPlatformSupported("win32")} darwin=${sandboxPlatformSupported("darwin")} linux=${sandboxPlatformSupported("linux")}`,
    )
  }

  // ── W8 信息探测：SRT Windows Alpha 后端状态（只读，不安装不修改系统） ──
  console.log("\n--- SRT Windows Alpha 后端探测（信息项，不参与 PASS/FAIL） ---")
  try {
    const srt = await import("@anthropic-ai/sandbox-runtime")
    if (typeof srt.checkWindowsSandboxStatusAsync === "function") {
      const status = await srt.checkWindowsSandboxStatusAsync()
      console.log("sandbox user:", JSON.stringify(status.user).slice(0, 300))
      console.log("wfp:", JSON.stringify(status.wfp).slice(0, 300))
    } else {
      console.log("该版本未导出 checkWindowsSandboxStatusAsync")
    }
    console.log("isSupportedPlatform():", srt.SandboxManager?.isSupportedPlatform?.())
  } catch (e) {
    console.log("探测失败（不影响交付）:", String((e as Error).message).slice(0, 200))
  }

  const failed = results.filter(([, ok]) => !ok).length
  console.log(`\nWindows 验证：${results.length - failed}/${results.length} 通过`)
  process.exitCode = failed === 0 ? 0 : 1
}

void main().catch((e) => {
  console.error("Windows 验证脚本崩溃:", e)
  process.exitCode = 2
})
