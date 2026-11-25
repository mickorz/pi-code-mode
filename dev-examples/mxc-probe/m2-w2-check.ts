/**
 * M2-W2 —— Workspace Registry MVP 验证（Windows MXC，Node ^24.21.0 || ^26.8.0）
 *
 * 验收 6 项（评审定义）：
 *   W2-01 两个工作区注册（自动登记）
 *   W2-02 A 读取 B → 拒绝
 *   W2-03 A 写入 A → 允许
 *   W2-04 B 关闭后 A 读取 B → 仍拒绝（条目保留，不因 owner 归零而删）
 *   W2-05 多 Run 同工作区 → 不发生提前注销
 *   W2-06 并行 Sandbox → 权限无交叉
 *
 * 两个安全边界：
 *   S1 路径绕过：大小写 / 尾分隔符 / 相对路径 / 嵌套工作区 / junction 不得绕过 deny
 *   S2 fail-closed：注册表未命中或路径解析失败 → 拒绝执行，绝不退化为空 deny
 *
 * 用法：nvm 的 Node 26.8+ 执行
 *   "…\v26.11.1\node.exe" --import ./node_modules/tsx/dist/loader.mjs m2-w2-check.ts
 */
import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import path from "node:path"

import {
  SrtCommandExecutor,
  WorkspaceRegistry,
  WorkspaceRegistryError,
  normalizeWorkspacePath,
  canonicalKeyOf,
} from "../../packages/execution/src/index.js"

const execFileAsync = promisify(execFile)
const rows: Array<[string, boolean | "warn", string]> = []
const rec = (id: string, ok: boolean | "warn", d: string) => {
  rows.push([id, ok, d])
  console.log(`${ok === "warn" ? "WARN" : ok ? "PASS" : "FAIL"}  ${id}  | ${d}`)
}

const base = path.join(process.env.SystemDrive ?? "C:", "pcm-m2w2")
await mkdir(base, { recursive: true })
const root = await mkdtemp(path.join(base, "run-"))
const pathA = path.join(root, "game-a")
const pathB = path.join(root, "game-b")
const pathC = path.join(root, "rule-kb")
await mkdir(pathA, { recursive: true })
await mkdir(pathB, { recursive: true })
await mkdir(pathC, { recursive: true })
await writeFile(path.join(pathB, "b-secret.txt"), "SECRET_OF_B", "utf8")
await writeFile(path.join(pathC, "c-secret.txt"), "SECRET_OF_C", "utf8")

const registry = new WorkspaceRegistry()
const ex = new SrtCommandExecutor({ windowsBackend: "mxc", workspaceRegistry: registry })

try {
  // ── W2-01 注册 ──
  {
    const a = registry.register({ workspaceId: "A", rootPath: pathA })
    const b = registry.register({ workspaceId: "B", rootPath: pathB })
    const c = registry.register({ workspaceId: "C", rootPath: pathC })
    rec(
      "W2-01 三个工作区注册（自动登记能力）",
      registry.getAll().length === 3 && a.key !== b.key && !!registry.findByPath(pathA),
      `条目=${registry.getAll().length} findByPath(A)=${registry.findByPath(pathA)?.workspaceId}`,
    )
  }

  registry.acquire("A", "run-1")
  registry.acquire("B", "run-2")
  registry.acquire("C", "run-3")

  // ── W2-03 A 写 A（允许） ──
  {
    const r = await ex.execute({
      command: "cmd /c echo A_OWN > own.txt && type own.txt",
      cwd: pathA,
      timeoutMs: 60000,
    })
    const disk = await readFile(path.join(pathA, "own.txt"), "utf8").catch(() => "")
    rec("W2-03 A 写入 A（允许）", r.exitCode === 0 && disk.includes("A_OWN"), `exit=${r.exitCode} disk=${JSON.stringify(disk.trim())}`)
  }

  // ── W2-02 A 读 B（拒绝，自动注入 deny，调用方不传 anything） ──
  {
    const r = await ex.execute({
      command: `cmd /c type "${path.join(pathB, "b-secret.txt")}" 2>&1`,
      cwd: pathA,
      timeoutMs: 60000,
    })
    const leaked = (r.stdout + r.stderr).includes("SECRET_OF_B")
    rec("W2-02 A 读取 B（拒绝，Runtime 自动注入）", !leaked, `exit=${r.exitCode} leaked=${leaked} out=${JSON.stringify((r.stdout + r.stderr).trim().slice(0, 60))}`)
  }

  // ── W2-06 并行 Sandbox 权限无交叉 ──
  {
    const [ra, rb] = await Promise.all([
      ex.execute({ command: "cmd /c echo PA > pa.txt && type pa.txt", cwd: pathA, timeoutMs: 60000 }),
      ex.execute({ command: "cmd /c echo PB > pb.txt && type pb.txt", cwd: pathB, timeoutMs: 60000 }),
    ])
    const crossBA = await readFile(path.join(pathA, "pb.txt"), "utf8").catch(() => undefined)
    const crossAB = await readFile(path.join(pathB, "pa.txt"), "utf8").catch(() => undefined)
    rec(
      "W2-06 并行 Sandbox 无权限交叉",
      ra.exitCode === 0 && rb.exitCode === 0 && crossBA === undefined && crossAB === undefined,
      `ra=${ra.exitCode} rb=${rb.exitCode} 交叉A=${crossBA ?? "无"} 交叉B=${crossAB ?? "无"}`,
    )
  }

  // ── W2-05 多 Run 同工作区：不提前注销 ──
  {
    registry.acquire("A", "run-4")
    registry.release("A", "run-1") // A 仍有 run-4，不应变 inactive
    const entry = registry.getAll().find((e) => e.workspaceId === "A")
    let unregisterRefused = false
    try {
      registry.unregister("A")
    } catch (e) {
      unregisterRefused = e instanceof WorkspaceRegistryError && e.code === "owners_present"
    }
    rec(
      "W2-05 多 Run 同工作区不提前注销",
      entry?.status === "active" && entry.owners.length === 1 && unregisterRefused,
      `status=${entry?.status} owners=${JSON.stringify(entry?.owners)} 注销被拒=${unregisterRefused}`,
    )
  }

  // ── W2-04 B 关闭后 A 仍不能读 B ──
  {
    registry.release("B", "run-2")
    const bEntry = registry.getAll().find((e) => e.workspaceId === "B")
    const r = await ex.execute({
      command: `cmd /c type "${path.join(pathB, "b-secret.txt")}" 2>&1`,
      cwd: pathA,
      timeoutMs: 60000,
    })
    const leaked = (r.stdout + r.stderr).includes("SECRET_OF_B")
    rec(
      "W2-04 B 关闭后 A 读取 B（仍拒绝）",
      bEntry?.status === "inactive" && !leaked,
      `B.status=${bEntry?.status} 条目仍在=${!!bEntry} leaked=${leaked}`,
    )
  }

  // ── S1 路径绕过尝试 ──
  {
    // 大小写 / 尾分隔符 / 相对片段 应得到同一比较键
    const variants = [
      pathA,
      pathA.toUpperCase(),
      `${pathA}\\`,
      `${pathA}\\..\\${path.basename(pathA)}`,
    ]
    const keys = new Set(variants.map((v) => normalizeWorkspacePath(v).canonicalKey))
    rec(
      "S1a 大小写/尾分隔符/相对片段规范化一致",
      keys.size === 1,
      `4 种写法 → ${keys.size} 个键${keys.size === 1 ? "（一致）" : `（不一致: ${[...keys].join(" | ")}）`}`,
    )

    // 用小写路径作为 cwd 发起读取，仍应被拒
    const lowerB = pathB.toLowerCase()
    const r = await ex.execute({
      command: `cmd /c type "${path.join(lowerB, "b-secret.txt")}" 2>&1`,
      cwd: pathA,
      timeoutMs: 60000,
    })
    const leaked = (r.stdout + r.stderr).includes("SECRET_OF_B")
    rec("S1b 小写路径访问 B 仍被拒", !leaked, `exit=${r.exitCode} leaked=${leaked}`)

    // 嵌套工作区：在 A 内创建嵌套工作区 N，N 也应 deny B
    const pathN = path.join(pathA, "nested-n")
    await mkdir(pathN, { recursive: true })
    registry.register({ workspaceId: "N", rootPath: pathN })
    registry.acquire("N", "run-n")
    const policyN = registry.getIsolationPolicy("N")
    const denyHasB = policyN.denyWorkspaces.some((p) => canonicalKeyOf(p).endsWith("game-b"))
    rec(
      "S1c 嵌套工作区 N 的 deny 集合包含 B",
      denyHasB,
      `N deny=${JSON.stringify(policyN.denyWorkspaces.map((p) => path.basename(p)))}`,
    )
    const rn = await ex.execute({
      command: `cmd /c type "${path.join(pathB, "b-secret.txt")}" 2>&1`,
      cwd: pathN,
      timeoutMs: 60000,
    })
    rec("S1d 从嵌套工作区 N 读 B 被拒", !(rn.stdout + rn.stderr).includes("SECRET_OF_B"), `exit=${rn.exitCode}`)

    // junction 指向 B：从 A 内经由 junction 读 B 应被拒（deny 生效于真实路径）
    const junction = path.join(pathA, "link-to-b")
    let junctionMade = false
    try {
      await symlink(pathB, junction, "junction")
      junctionMade = true
    } catch {
      /* 无权限创建 junction */
    }
    if (junctionMade) {
      const rj = await ex.execute({ command: `cmd /c type "${path.join(junction, "b-secret.txt")}" 2>&1`, cwd: pathA, timeoutMs: 60000 })
      rec("S1e 经由 junction 读 B 被拒", !(rj.stdout + rj.stderr).includes("SECRET_OF_B"), `exit=${rj.exitCode}`)
    } else {
      rec("S1e junction 绕过测试", "warn", "无法创建 junction（权限）")
    }
  }

  // ── S2 fail-closed ──
  {
    // 未登记目录：注册表存在 → 拒绝执行
    const unregistered = await mkdtemp(path.join(root, "unreg-"))
    const r1 = await ex.execute({ command: "cmd /c echo X", cwd: unregistered, timeoutMs: 30000 })
    rec(
      "S2a 未登记目录拒绝执行（不退化空 deny）",
      r1.blocked === true && /未登记|isolation_unavailable/.test(r1.blockReason ?? ""),
      `blocked=${r1.blocked} reason=${JSON.stringify((r1.blockReason ?? "").slice(0, 70))}`,
    )

    // 注册表路径解析失败：非法路径应抛错而非静默
    let threw = false
    try {
      normalizeWorkspacePath("bad\0path")
    } catch {
      threw = true
    }
    rec("S2b 非法路径解析失败即抛错（不静默降级）", threw, `抛错=${threw}`)

    // 注销仍有 owner 的工作区应被拒（已在 W2-05 覆盖，这里补显式断言）
    let refused = false
    try {
      registry.unregister("C")
    } catch (e) {
      refused = e instanceof WorkspaceRegistryError && e.code === "owners_present"
    }
    rec("S2c 有 owner 时注销被拒", refused, `拒绝=${refused}`)
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

const fail = rows.filter(([, s]) => s === false)
const warn = rows.filter(([, s]) => s === "warn")
console.log(`\n=== 判定 === PASS ${rows.length - fail.length - warn.length} / WARN ${warn.length} / FAIL ${fail.length}`)
if (fail.length) {
  console.log("未通过：")
  for (const [id, , d] of fail) console.log(`  - ${id}: ${d}`)
  process.exitCode = 1
} else if (warn.length) {
  for (const [id, , d] of warn) console.log(`  WARN ${id}: ${d}`)
}
void execFileAsync
void spawn
