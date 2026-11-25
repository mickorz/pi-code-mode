/**
 * Sandbox Host 协议自检 —— 任何平台可跑（验证 stdin JSON / fd3 控制通道 / 失败路径）
 *
 * Windows 上预期：Host 收到 payload 后因平台不支持报 "failed 125" 并退出 125，
 * 命令一条都不执行（证明"明确拒绝、不降级宿主执行"）。
 * macOS/Linux 上：应报 "ready" 并真实执行。
 *
 * 用法：npx tsx host-protocol-check.ts
 */
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const compiled = path.resolve(here, "../../dist/packages/execution/src/sandbox/sandbox-host.js")
const source = path.resolve(here, "../../packages/execution/src/sandbox/sandbox-host.ts")
const useCompiled = existsSync(compiled)
const script = useCompiled ? compiled : source
const execArgv = useCompiled ? [] : ["--import", createRequire(import.meta.url).resolve("tsx")]

const workspace = await mkdtemp(path.join(os.tmpdir(), "pcm-hostproto-"))
const marker = path.join(workspace, "marker.txt")

const payload = {
  command: `echo PROTO_OK > ${JSON.stringify(marker)}; echo PROTO_OK`,
  cwd: workspace,
  policy: { workspace },
  commandId: "proto-check-1",
  commandText: "echo PROTO_OK",
}

const child = spawn(process.execPath, [...execArgv, script], {
  cwd: workspace,
  detached: true,
  stdio: ["pipe", "pipe", "pipe", "pipe"],
})

const controlLines: string[] = []
let controlBuf = ""
;(child.stdio[3] as NodeJS.ReadableStream | null)?.on("data", (c: Buffer) => {
  controlBuf += c.toString("utf8")
  let i: number
  while ((i = controlBuf.indexOf("\n")) >= 0) {
    controlLines.push(controlBuf.slice(0, i).trim())
    controlBuf = controlBuf.slice(i + 1)
  }
})

let stdout = ""
child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")))
let stderr = ""
child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")))

child.stdin.write(`${JSON.stringify(payload)}\n`)
// stdin 保持打开（存活信号），等 Host 自己收尾

const code: number | null = await new Promise((resolve) => child.once("exit", (c) => resolve(c)))
await new Promise((r) => setTimeout(r, 300))

const onDisk = await readFile(marker, "utf8").catch(() => undefined)
const hasReady = controlLines.includes("ready")
const failedLine = controlLines.find((l) => l.startsWith("failed"))

console.log("平台:", process.platform)
console.log("Host 入口:", useCompiled ? "dist(js)" : "src(ts via tsx)")
console.log("控制通道行:", JSON.stringify(controlLines))
console.log("退出码:", code)
console.log("stdout:", JSON.stringify(stdout.trim().slice(0, 100)))
console.log("marker 文件:", onDisk === undefined ? "未创建" : JSON.stringify(onDisk.trim()))

let ok: boolean
if (process.platform === "win32") {
  // Windows：必须明确失败、命令绝不执行
  ok = code === 125 && !!failedLine && onDisk === undefined && !stdout.includes("PROTO_OK")
  console.log(
    ok
      ? "\n[通过] Windows 明确拒绝（failed 125），命令零执行、无宿主降级"
      : "\n[失败] Windows 应明确拒绝且不执行命令",
  )
} else {
  // macOS/Linux：应 ready 并真实执行
  ok = hasReady && code === 0 && onDisk?.trim() === "PROTO_OK" && stdout.includes("PROTO_OK")
  console.log(ok ? "\n[通过] 协议正常：ready -> 执行 -> 退出 0" : "\n[失败] 协议或执行异常")
}
if (stderr.trim()) console.log("stderr:", JSON.stringify(stderr.trim().slice(0, 200)))

await rm(workspace, { recursive: true, force: true })
process.exitCode = ok ? 0 : 1
