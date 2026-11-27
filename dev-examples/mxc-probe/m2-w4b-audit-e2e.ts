/**
 * M2-W4b —— 审计落盘端到端：真实构建 + 拒绝路径都写入 JSONL
 * 用法：Node ^24.21 || ^26.8
 */
import { readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import {
  AUDIT_DIR,
  ControlPlaneAuditWriter,
  ControlPlaneExecutor,
  auditFileName,
} from "../../packages/execution/src/index.js"

const CLI = "E:/CocosProjects/CocosCLI"
const CREATOR = "D:/CocosSofts/Creator/3.7.3/CocosCreator.exe"
const dir = path.join(CLI, ".pi", "workflows", "audit")
// 清掉旧审计，确保看到的是本次
await rm(path.join(dir, auditFileName()), { force: true }).catch(() => undefined)

const writer = new ControlPlaneAuditWriter(CLI)
const rule = { match: /index\.js build/, reason: "GUI 构建链无法在 MXC 内启动" }
const cmd = `cmd /c set COCOS_CREATOR_PATH=${CREATOR} && node dist/index.js build web-mobile examples/cocos_example_proj`

// 1) 拒绝路径（无审批）
const deniedCp = new ControlPlaneExecutor({ allow: [rule], onAudit: (e) => void writer.write(e) })
await deniedCp.execute({ command: cmd, cwd: CLI })

// 2) 批准路径（真实构建）
const approvedCp = new ControlPlaneExecutor({
  allow: [rule],
  approve: async () => true,
  onAudit: (e) => void writer.write(e),
})
const t0 = Date.now()
const r = await approvedCp.execute({ command: cmd, cwd: CLI, timeoutMs: 900000, runId: "run-audit", executionId: "exec-audit" })
await writer.flush()

const file = path.join(dir, auditFileName())
const text = await readFile(file, "utf8")
const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l))

console.log(`构建 exit=${r.exitCode} 耗时=${Math.round((Date.now() - t0) / 1000)}s`)
console.log(`审计文件: ${file}`)
console.log(`记录数: ${lines.length}`)
for (const l of lines) console.log(`  ${l.ts} | ${l.decision} | exit=${l.exitCode ?? "-"} | ${l.denyReason ?? l.rule} | runId=${l.runId ?? "-"}`)

const hasDenied = lines.some((l) => l.decision === "denied" && l.denyReason === "no_approval_channel")
const hasApproved = lines.some((l) => l.decision === "approved" && l.exitCode === 0 && l.runId === "run-audit")
const noContent = !text.includes("stdout") && !text.includes("stderr")
const ok = hasDenied && hasApproved && noContent
console.log(`\n判定: ${ok ? "PASS" : "FAIL"}（拒绝已记录=${hasDenied} 批准已记录=${hasApproved} 不含输出=${noContent}）`)
process.exitCode = ok ? 0 : 1
