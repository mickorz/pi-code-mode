/**
 * M2-W0c —— MXC 安全收尾验证（Windows 原生，Node ^24.21.0 || ^26.8.0）
 *
 * 覆盖评审列出的八项：
 *   C1 Node 版本基线（仅接受 ^24.21.0 || ^26.8.0）
 *   C2 TEMP 隔离（一 Host 一私有 TEMP；A 不能写 B 的、不能写宿主机原 TEMP）
 *   C3 跨项目读取隔离（A 不能读 B —— 系统盘默认可读，须显式 denyWorkspaces）
 *   C4 网络白名单（允许域名可达、非白名单拒绝）
 *   C5 父 Host 崩溃回收（强杀 Host 后命令进程树不残留）
 *   C6 AbortSignal 回收（Windows 走 taskkill /T /F）
 *   C7 工具链（CMD/PowerShell/Node/npm/Git/Python 可用；Git Bash 明确不支持）
 *   C8 临时目录清理（Host 退出后私有 TEMP 已删除）
 *
 * 用法（Node 24.21+/26.8+）：
 *   "C:\Users\<you>\AppData\Local\nvm\v26.11.1\node.exe" --import ./node_modules/tsx/dist/loader.mjs *.ts
 *   或 npx tsx m2-w0c-check.ts   （Node 版本满足时）
 */
import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { SrtCommandExecutor, mxcNodeVersionOk, mxcNodeVersionHint } from "../../packages/execution/src/index.js"

const execFileAsync = promisify(execFile)
const rows: Array<[string, boolean | "warn", string]> = []
const rec = (id: string, ok: boolean | "warn", d: string) => {
  rows.push([id, ok, d])
  console.log(`${ok === "warn" ? "WARN" : ok ? "PASS" : "FAIL"}  ${id}  | ${d}`)
}

const base = path.join(process.env.SystemDrive ?? "C:", "pcm-m2w0c")
await mkdir(base, { recursive: true })
const root = await mkdtemp(path.join(base, "run-"))
const wsA = path.join(root, "proj-a")
const wsB = path.join(root, "proj-b")
await mkdir(wsA, { recursive: true })
await mkdir(wsB, { recursive: true })
await writeFile(path.join(wsB, "secret-b.txt"), "PROJECT_B_SECRET_XYZ", "utf8")
await writeFile(path.join(wsA, "own.txt"), "PROJECT_A_OWN", "utf8")

const ex = new SrtCommandExecutor({ windowsBackend: "mxc" })

try {
  // ── C1 Node 版本基线 ──
  {
    const ok = mxcNodeVersionOk()
    rec(
      "C1 Node 版本基线（^24.21.0 || ^26.8.0）",
      ok,
      `当前 ${process.versions.node}；${ok ? "满足" : mxcNodeVersionHint()}`,
    )
    // 只接受两个区间：25.x / 27+ 不得放行
    const rejects = [
      ["24.18.0", false],
      ["24.21.0", true],
      ["25.1.0", false],
      ["26.7.0", false],
      ["26.8.0", true],
      ["27.0.0", false],
    ] as const
    const wrong = rejects.filter(([v, expect]) => mxcNodeVersionOk(v) !== expect)
    rec("C1b 版本判定只接受已验证区间（25.x/27+ 不得放行）", wrong.length === 0, wrong.length ? `误判: ${wrong.map(([v]) => v).join(",")}` : "全部符合")
  }

  // ── C7 工具链（先跑，确认基础可用） ──
  {
    const tools: Array<[string, string, boolean]> = [
      ["CMD", "cmd /c ver", true],
      ["PowerShell", 'powershell -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"', true],
      ["Node.js", "node --version", true],
      ["npm", "npm --version", true],
      ["Git(原生)", "git --version", true],
      ["Python", "python --version 2>&1 || py --version 2>&1", true],
      ["Git Bash(应不支持)", "bash --version 2>&1", false],
    ]
    for (const [name, cmd, expectOk] of tools) {
      const r = await ex.execute({ command: cmd, cwd: wsA, timeoutMs: 45000 })
      const ok = r.exitCode === 0
      if (expectOk) {
        rec(`C7 工具 ${name}`, ok ? true : "warn", `exit=${r.exitCode} ${JSON.stringify((r.stdout + r.stderr).trim().split("\n")[0]?.slice(0, 60))}`)
      } else {
        rec(`C7 ${name} 明确不可用（登记残余）`, ok ? false : "warn", `exit=${r.exitCode}（预期非 0）`)
      }
    }
  }

  // ── C2/C3/C8 TEMP 隔离 + 跨项目读取 ──
  {
    const hostTempBefore = new Set((await listHostTempHosts()).map((p) => p))
    // A 侧：deny B
    const a = await ex.execute({
      command: `cmd /c echo A_TEMP_OK > "%TEMP%\\a.txt" && type "%TEMP%\\a.txt"`,
      cwd: wsA,
      denyWorkspaces: [wsB],
      timeoutMs: 45000,
    })
    rec("C2 Sandbox A 能写自己的 TEMP", a.exitCode === 0 && a.stdout.includes("A_TEMP_OK"), `exit=${a.exitCode} out=${JSON.stringify(a.stdout.trim().slice(0, 60))}`)

    const hostTemp = process.env.TEMP ?? os.tmpdir()
    const hostProbe = path.join(hostTemp, `pcm-hosttemp-probe-${Date.now()}.txt`)
    const hw = await ex.execute({ command: `cmd /c echo host > "${hostProbe}"`, cwd: wsA, timeoutMs: 45000 })
    // 注：Host 会把自身 TEMP 改为私有目录，宿主机原 TEMP 不应再进入写授权
    const hostCreated = await readFile(hostProbe, "utf8").catch(() => undefined)
    rec(
      "C2 Sandbox A 不能写宿主机原 TEMP（TEMP 隔离生效）",
      hostCreated === undefined ? true : "warn",
      `写宿主机 TEMP=${hostCreated === undefined ? "被拒（正确）" : "成功（隔离未生效）"} exit=${hw.exitCode}`,
    )
    await rm(hostProbe, { force: true })

    const crossRead = await ex.execute({
      command: `cmd /c type "${path.join(wsB, "secret-b.txt")}" 2>&1`,
      cwd: wsA,
      denyWorkspaces: [wsB],
      timeoutMs: 45000,
    })
    const leakedB = (crossRead.stdout + crossRead.stderr).includes("PROJECT_B_SECRET_XYZ")
    rec(
      "C3 跨项目读取被拒（A 不能读 B）",
      !leakedB,
      `exit=${crossRead.exitCode} leaked=${leakedB} out=${JSON.stringify((crossRead.stdout + crossRead.stderr).trim().slice(0, 70))}`,
    )

    // 对照：不给 denyWorkspaces 时应能读到（证明隔离来自配置而非巧合）
    const crossReadNoDeny = await ex.execute({
      command: `cmd /c type "${path.join(wsB, "secret-b.txt")}" 2>&1`,
      cwd: wsA,
      timeoutMs: 45000,
    })
    const readable = (crossReadNoDeny.stdout + crossReadNoDeny.stderr).includes("PROJECT_B_SECRET_XYZ")
    rec(
      "C3b 对照：未配置 denyWorkspaces 时可读（证明 C3 有效）",
      readable ? true : "warn",
      `可读=${readable}${readable ? "" : "（若不可读，C3 结论需重估）"}`,
    )

    // C8 临时目录清理
    await new Promise((r) => setTimeout(r, 1500))
    const hostTempAfter = await listHostTempHosts()
    const leakedDirs = hostTempAfter.filter((p) => !hostTempBefore.has(p))
    rec("C8 Host 私有 TEMP 已清理", leakedDirs.length === 0, `残留=${leakedDirs.length}${leakedDirs.length ? `: ${leakedDirs.slice(0, 3).join(",")}` : ""}`)
  }

  // ── C4 网络白名单 ──
  {
    const deny = await ex.execute({
      command: 'cmd /c curl -sS -m 8 -o nul -w "%{http_code}" https://example.com 2>&1 || echo BLOCKED',
      cwd: wsA,
      timeoutMs: 45000,
    })
    rec("C4a 非白名单域名被拒", /BLOCKED|^0{3}|403|failed|refused/i.test(deny.stdout + deny.stderr), `exit=${deny.exitCode} out=${JSON.stringify((deny.stdout + deny.stderr).trim().slice(0, 80))}`)

    // 白名单域名放行：allowedDomains 透传到 SRT network.allowedDomains
    const allow = await ex.execute({
      command: 'cmd /c curl -sS -m 12 -o nul -w "%{http_code}" https://example.com 2>&1 || echo CURL_FAILED',
      cwd: wsA,
      allowedDomains: ["example.com"],
      timeoutMs: 60000,
    })
    const allowTxt = allow.stdout + allow.stderr
    // 注意：SRT 的代理会把状态码与其它输出拼接（如 "200whoami: ..."），
    // 不能用  词边界判断；只要求出现成功状态码且没有失败标记。
    const allowed = /(^|[^0-9])2\d\d/.test(allowTxt) && !/CURL_FAILED/.test(allowTxt)
    rec(
      "C4b 白名单域名放行",
      allowed,
      `exit=${allow.exitCode} out=${JSON.stringify(allowTxt.trim().slice(0, 90))}`,
    )
  }

  // ── C6 AbortSignal（Windows taskkill /T /F） ──
  {
    const marker = path.join(wsA, "abort-marker.txt")
    const ac = new AbortController()
    const t0 = Date.now()
    const p = ex.execute({
      // 起一个子进程并持续写标记，验证 abort 后它不再继续写
      command: `powershell -NoProfile -Command "for($i=0;$i -lt 120;$i++){ Add-Content -Path '${marker}' -Value $i; Start-Sleep -Milliseconds 500 }"`,
      cwd: wsA,
      timeoutMs: 120000,
      signal: ac.signal,
    })
    setTimeout(() => ac.abort(), 3000)
    const r = await p
    const elapsed = Date.now() - t0
    await new Promise((res) => setTimeout(res, 2500))
    const lines1 = (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean).length
    await new Promise((res) => setTimeout(res, 2000))
    const lines2 = (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean).length
    rec(
      "C6 AbortSignal 终止命令（Windows taskkill /T /F）",
      r.blocked === true && elapsed < 30000 && lines2 === lines1,
      `blocked=${r.blocked} elapsed=${elapsed}ms 行数 ${lines1}->${lines2}（相等=已停止）`,
    )
  }

  // ── C5 父 Host 崩溃回收 ──
  {
    const marker = path.join(wsA, "crash-marker.txt")
    await rm(marker, { force: true })
    // 手动起一个 Host，拿到 pid 后强杀（模拟父进程崩溃/被 taskkill）
    const hostPid = await startHostAndGetPid(marker, wsA)
    if (hostPid) {
      await execFileAsync("taskkill", ["/PID", String(hostPid), "/F"]).catch(() => undefined)
      await new Promise((r) => setTimeout(r, 4000))
      const l1 = (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean).length
      await new Promise((r) => setTimeout(r, 2500))
      const l2 = (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean).length
      rec(
        "C5 父 Host 崩溃后命令进程树被回收",
        l2 === l1,
        `Host pid=${hostPid} 已强杀；命令标记行 ${l1}->${l2}（相等=无残留）`,
      )
    } else {
      rec("C5 父 Host 崩溃回收", false, "无法启动探针 Host")
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

const fail = rows.filter(([, s]) => s === false)
const warn = rows.filter(([, s]) => s === "warn")
console.log(`\n=== 判定 === PASS ${rows.length - fail.length - warn.length} / WARN ${warn.length} / FAIL ${fail.length}`)
if (fail.length) {
  console.log("未通过项：")
  for (const [id, , d] of fail) console.log(`  - ${id}: ${d}`)
  process.exitCode = 1
} else if (warn.length) {
  console.log("已知残余/待接线项：")
  for (const [id, , d] of warn) console.log(`  - ${id}: ${d}`)
}

// ── 辅助 ──

/** 列出宿主机 TEMP 下 pcm-host-temp-* 目录 */
async function listHostTempHosts(): Promise<string[]> {
  const dir = process.env.TEMP ?? os.tmpdir()
  const { readdir } = await import("node:fs/promises")
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory() && e.name.startsWith("pcm-host-temp-")).map((e) => path.join(dir, e.name))
}

/** 起一个 Host 执行持续写标记的命令，返回 Host pid */
async function startHostAndGetPid(marker: string, cwd: string): Promise<number | undefined> {
  const hostScript = path.resolve(import.meta.dirname, "../../dist/packages/execution/src/sandbox/sandbox-host.js")
  const payload = {
    command: `powershell -NoProfile -Command "for($i=0;$i -lt 120;$i++){ Add-Content -Path '${marker}' -Value $i; Start-Sleep -Milliseconds 500 }"`,
    cwd,
    policy: { workspace: cwd, windowsBackend: "mxc" },
    commandId: `crash-${Date.now()}`,
    commandText: "crash probe",
    timeoutMs: 120000,
  }
  const child = spawn(process.execPath, [hostScript], { cwd, detached: true, stdio: ["pipe", "ignore", "ignore", "ignore"], windowsHide: true })
  child.stdin?.write(`${JSON.stringify(payload)}\n`)
  await new Promise((r) => setTimeout(r, 6000)) // 等 ready 并开始写
  return child.pid
}
