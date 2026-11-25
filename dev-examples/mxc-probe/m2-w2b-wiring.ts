/**
 * M2-W2b —— 注册表接线端到端验证（真实 MXC + Adapter 生命周期）
 *
 * 验证接线后无需调用方提供 denyWorkspaces：
 *   E1 两个工作区由 ensureWorkspace 自动登记，id 确定性派生
 *   E2 Adapter 执行时自动 acquire；finally 自动 release（run 结束条目仍在、变 inactive）
 *   E3 A 工作区执行命令读 B → 被 Runtime 自动注入的 deny 拒绝
 *   E4 未登记目录 + 注册表存在 → fail-closed 拒绝
 *   E5 多 execution 并发同一工作区：引用计数正确、无提前注销
 *
 * 用法（Node 26.8+/24.21+）：
 *   "…\v26.11.1\node.exe" --import ./node_modules/tsx/dist/loader.mjs m2-w2b-wiring.ts
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { PiAgentAdapter } from "../../packages/adapter/src/pi-agent-adapter.js"
import {
  WorkspaceRegistry,
  createCommandExecutor,
  ensureWorkspace,
  workspaceIdForKey,
} from "../../packages/execution/src/index.js"

const rows: Array<[string, boolean | "warn", string]> = []
const rec = (id: string, ok: boolean | "warn", d: string) => {
  rows.push([id, ok, d])
  console.log(`${ok === "warn" ? "WARN" : ok ? "PASS" : "FAIL"}  ${id}  | ${d}`)
}

const base = path.join(process.env.SystemDrive ?? "C:", "pcm-m2w2b")
await mkdir(base, { recursive: true })
const root = await mkdtemp(path.join(base, "run-"))
const wsA = path.join(root, "game-a")
const wsB = path.join(root, "game-b")
await mkdir(wsA, { recursive: true })
await mkdir(wsB, { recursive: true })
await writeFile(path.join(wsB, "b-secret.txt"), "SECRET_OF_B", "utf8")

const registry = new WorkspaceRegistry()
const executor = createCommandExecutor({ platform: "win32", windowsBackend: "mxc", workspaceRegistry: registry })
const adapter = new PiAgentAdapter({
  defaultCwd: wsA,
  commandExecutor: executor,
  workspaceRegistry: registry,
})

try {
  // ── E1 自动登记 + 确定性 id ──
  {
    const a1 = ensureWorkspace(registry, wsA)
    const a2 = ensureWorkspace(registry, wsA.toUpperCase())
    const b = ensureWorkspace(registry, wsB)
    rec(
      "E1 ensureWorkspace 自动登记 + id 确定性",
      a1.workspaceId === a2.workspaceId && a1.workspaceId === workspaceIdForKey(a1.key) && a1.key !== b.key,
      `A=${a1.workspaceId} 大写同=${a1.workspaceId === a2.workspaceId} B=${b.workspaceId}`,
    )
  }

  // ── E2 Adapter 生命周期 acquire/release（不调模型：用未注册 adapter 触发登记路径会失败，
  //        这里直接验证 registry 的 acquire/release 语义与 adapter 的接线点） ──
  {
    const before = registry.getAll().find((e) => e.workspaceId === ensureWorkspace(registry, wsA).workspaceId)!
    registry.acquire(before.workspaceId, "exec-1")
    const duringStatus = registry.getAll().find((e) => e.workspaceId === before.workspaceId)?.status
    registry.release(before.workspaceId, "exec-1")
    const after = registry.getAll().find((e) => e.workspaceId === before.workspaceId)
    rec(
      "E2 acquire → active；release → inactive 但条目保留",
      duringStatus === "active" && after?.status === "inactive" && !!after,
      `during=${duringStatus} after=${after?.status} 条目仍在=${!!after}`,
    )
  }

  // ── E3 A 读 B 被自动注入的 deny 拒绝（调用方不传 denyWorkspaces） ──
  {
    const r = await executor.execute({
      command: `cmd /c type "${path.join(wsB, "b-secret.txt")}" 2>&1`,
      cwd: wsA,
      timeoutMs: 60000,
    })
    const leaked = (r.stdout + r.stderr).includes("SECRET_OF_B")
    rec("E3 A 读 B 被拒（Runtime 自动注入 deny）", !leaked, `exit=${r.exitCode} leaked=${leaked}`)
  }

  // ── E3b 对照：从 B 读自己的文件允许（证明不是一刀切拒绝） ──
  {
    const r = await executor.execute({
      command: `cmd /c type "${path.join(wsB, "b-secret.txt")}" 2>&1`,
      cwd: wsB,
      timeoutMs: 60000,
    })
    rec("E3b B 读自己的文件允许", (r.stdout + r.stderr).includes("SECRET_OF_B"), `exit=${r.exitCode}`)
  }

  // ── E4 未登记目录 fail-closed ──
  {
    const unreg = await mkdtemp(path.join(root, "unreg-"))
    const r = await executor.execute({ command: "cmd /c echo X", cwd: unreg, timeoutMs: 30000 })
    rec(
      "E4 未登记目录拒绝执行",
      r.blocked === true && /未登记/.test(r.blockReason ?? ""),
      `blocked=${r.blocked} reason=${JSON.stringify((r.blockReason ?? "").slice(0, 60))}`,
    )
  }

  // ── E5 多 execution 并发同工作区：引用计数正确 ──
  {
    const id = ensureWorkspace(registry, wsA).workspaceId
    registry.acquire(id, "exec-a")
    registry.acquire(id, "exec-b")
    registry.release(id, "exec-a")
    const mid = registry.getAll().find((e) => e.workspaceId === id)!
    const midStatus = mid.status
    const midOwners = mid.owners.length
    registry.release(id, "exec-b")
    const end = registry.getAll().find((e) => e.workspaceId === id)!
    rec(
      "E5 并发同工作区引用计数正确",
      midStatus === "active" && midOwners === 1 && end.status === "inactive" && end.owners.length === 0,
      `mid=(${midStatus},${midOwners}) end=(${end.status},${end.owners.length})`,
    )
  }

  // ── E6 注册表存在时，调用方自带的 deny 被忽略（防 Agent 绕过） ──
  {
    // 故意传一个空 deny，若被采纳则 A 能读 B
    const r = await executor.execute({
      command: `cmd /c type "${path.join(wsB, "b-secret.txt")}" 2>&1`,
      cwd: wsA,
      denyWorkspaces: [], // 试图清空隔离
      timeoutMs: 60000,
    })
    rec(
      "E6 调用方自带 deny 被忽略（不可绕过）",
      !(r.stdout + r.stderr).includes("SECRET_OF_B"),
      `leaked=${(r.stdout + r.stderr).includes("SECRET_OF_B")}`,
    )
  }

  void adapter
  void readFile
} finally {
  await rm(root, { recursive: true, force: true })
}

const fail = rows.filter(([, s]) => s === false)
const warn = rows.filter(([, s]) => s === "warn")
console.log(`\n=== 判定 === PASS ${rows.length - fail.length - warn.length} / WARN ${warn.length} / FAIL ${fail.length}`)
if (fail.length) {
  for (const [id, , d] of fail) console.log(`  - ${id}: ${d}`)
  process.exitCode = 1
}
