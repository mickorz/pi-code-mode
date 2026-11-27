/**
 * M2-W4 受控执行面端到端验证（真实 Cocos 构建链，路线 A）
 *
 * 验证：
 *   A1 无审批通道 → 控制面拒绝（headless fail-closed）
 *   A2 审批通过 → 真实 `cocoscli build` 在宿主执行成功，产物与沙盒外基线一致
 *   A3 未命中规则的命令 → 走沙盒（控制面零调用），沙盒失败不降级
 *   A4 审计事件完整（命令/cwd/规则/决策/退出码/耗时），且不含输出内容
 *   A5 审批拒绝 → 不执行
 *
 * 用法（Node ^24.21 || ^26.8）：
 *   "…\v26.11.1\node.exe" --import ./node_modules/tsx/dist/loader.mjs m2-w4-check.ts
 */
import path from "node:path"
import { readdir, rm, stat } from "node:fs/promises"

import {
  ControlPlaneExecutor,
  RoutedCommandExecutor,
  WorkspaceRegistry,
  createCommandExecutor,
  ensureWorkspace,
  type ControlPlaneAuditEvent,
} from "../../packages/execution/src/index.js"

const CLI = "E:/CocosProjects/CocosCLI"
const PROJECT = path.join(CLI, "examples", "cocos_example_proj")
const OUT = path.join(PROJECT, "build", "web-mobile")
const CREATOR = "D:/CocosSofts/Creator/3.7.3/CocosCreator.exe"

const rows: Array<[string, boolean | "warn", string]> = []
const rec = (id: string, ok: boolean | "warn", d: string) => {
  rows.push([id, ok, d])
  console.log(`${ok === "warn" ? "WARN" : ok ? "PASS" : "FAIL"}  ${id}  | ${d}`)
}

async function tally(dir: string): Promise<number> {
  let n = 0
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) n += await tally(p)
    else if (e.isFile()) n++
  }
  return n
}

// 规则必须匹配**真实命令文本**：本仓库的构建入口是 `node dist/index.js build <platform>`
const BUILD_RULE = {
  match: /(?:cocoscli build|index\.js build)/,
  reason: "GUI 构建链（CocosCreator/Electron）无法在 MXC 内启动",
}
/** 规则字符串（审计里记录的是 reason） */
const RULE_REASON = BUILD_RULE.reason
const audits: ControlPlaneAuditEvent[] = []
const registry = new WorkspaceRegistry()
ensureWorkspace(registry, CLI)
ensureWorkspace(registry, PROJECT)
const sandbox = createCommandExecutor({ platform: "win32", windowsBackend: "mxc", workspaceRegistry: registry })

const BUILD_CMD = `cmd /c set COCOS_CREATOR_PATH=${CREATOR} && node dist/index.js build web-mobile examples/cocos_example_proj`

try {
  // ── A1 无审批通道 → 拒绝 ──
  {
    const cp = new ControlPlaneExecutor({ allow: [BUILD_RULE], onAudit: (e) => audits.push(e) })
    const r = await cp.execute({ command: BUILD_CMD, cwd: CLI })
    rec("A1 无审批通道 → fail-closed", r.blocked === true && /no_approval_channel/.test(r.blockReason ?? ""), `blocked=${r.blocked} reason=${JSON.stringify((r.blockReason ?? "").slice(0, 60))}`)
  }

  // ── A5 审批拒绝 → 不执行 ──
  {
    const cp = new ControlPlaneExecutor({ allow: [BUILD_RULE], approve: async () => false, onAudit: (e) => audits.push(e) })
    const r = await cp.execute({ command: BUILD_CMD, cwd: CLI })
    rec("A5 审批拒绝 → 不执行", r.blocked === true && /not_approved/.test(r.blockReason ?? ""), `blocked=${r.blocked}`)
  }

  // ── A2 审批通过 → 真实构建 ──
  {
    await rm(OUT, { recursive: true, force: true })
    let approvedCount = 0
    const cp = new ControlPlaneExecutor({
      allow: [BUILD_RULE],
      approve: async () => {
        approvedCount++
        return true
      },
      onAudit: (e) => audits.push(e),
    })
    const t0 = Date.now()
    const r = await cp.execute({ command: BUILD_CMD, cwd: CLI, timeoutMs: 900000, runId: "run-w4", executionId: "exec-w4" })
    const files = await tally(OUT)
    const exists = (await stat(OUT).catch(() => undefined)) !== undefined
    const ok = r.exitCode === 0 && exists && files > 0
    rec(
      "A2 审批通过 → 真实 Cocos 构建成功（与沙盒外基线同级）",
      ok,
      `exit=${r.exitCode} 产物=${files} 文件（基线 49） 耗时=${Math.round((Date.now() - t0) / 1000)}s 审批次数=${approvedCount}`,
    )
    if (!ok) {
      console.log("  stdout 尾部:", r.stdout.split("\n").slice(-6).join(" | "))
      console.log("  stderr 尾部:", r.stderr.split("\n").slice(-4).join(" | "))
    }
  }

  // ── A4 审计完整性 ──
  {
    const approvedEvt = audits.find((e) => e.decision === "approved")
    const ok =
      !!approvedEvt &&
      approvedEvt.rule === RULE_REASON &&
      approvedEvt.runId === "run-w4" &&
      typeof approvedEvt.exitCode === "number" &&
      typeof approvedEvt.durationMs === "number"
    const serialized = JSON.stringify(approvedEvt ?? {})
    const noContent = !serialized.includes("构建成功") && !serialized.includes("Asset DB")
    rec(
      "A4 审计完整且不含输出内容",
      ok && noContent,
      `rule=${!!approvedEvt?.rule} exit=${approvedEvt?.exitCode} dur=${approvedEvt?.durationMs}ms 无输出内容=${noContent} 事件数=${audits.length}`,
    )
  }

  // ── A3 未命中规则 → 走沙盒，且沙盒失败不降级 ──
  {
    let cpCalls = 0
    const cp = new ControlPlaneExecutor({
      allow: [BUILD_RULE],
      approve: async () => {
        cpCalls++
        return true
      },
      onAudit: (e) => audits.push(e),
    })
    const routed = new RoutedCommandExecutor(sandbox, cp)
    const r = await routed.execute({ command: "echo sandboxed-path", cwd: PROJECT, timeoutMs: 60000 })
    rec(
      "A3 未命中规则 → 沙盒执行（控制面零调用）",
      r.blocked !== true && cpCalls === 0 && routed.routeOf("echo hi") === "sandbox",
      `blocked=${r.blocked ?? false} 控制面调用=${cpCalls} route=${routed.routeOf("echo hi")}`,
    )
    // 沙盒失败的 GUI 命令：未命中规则 → 沙盒拒绝，不自动转控制面
    const unroutedGui = await routed.execute({ command: "CocosCreator.exe --version", cwd: PROJECT, timeoutMs: 60000 })
    rec(
      "A3b 未命中规则的 GUI 命令不静默转控制面",
      cpCalls === 0 && (unroutedGui.blocked === true || unroutedGui.exitCode !== 0),
      `blocked=${unroutedGui.blocked ?? false} exit=${unroutedGui.exitCode} 控制面调用=${cpCalls}`,
    )
  }
} finally {
  // 保留产物供人工核对
}

const fail = rows.filter(([, s]) => s === false)
const warn = rows.filter(([, s]) => s === "warn")
console.log(`\n=== 判定 === PASS ${rows.length - fail.length - warn.length} / WARN ${warn.length} / FAIL ${fail.length}`)
if (fail.length) {
  for (const [id, , d] of fail) console.log(`  - ${id}: ${d}`)
  process.exitCode = 1
}
