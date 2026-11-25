/**
 * M2-W0 —— Windows Sandbox 可行性验证（在隔离 Windows 测试环境执行，勿在日常开发主机首跑）
 *
 * 前置（手动完成，本脚本只验证不安装）：
 *   1. Windows 11 VM + 系统快照
 *   2. npm i @anthropic-ai/sandbox-runtime@0.0.83
 *   3. 一次性安装（UAC）：npx sandbox-runtime windows-install --sublayer-guid <GUID> --skip-profile-grant
 *      —— 不要加 --allow-loopback；不要授权 Profile Read Grant
 *   4. 记录安装前的用户/WFP/ACL/CA 状态（见 --snapshot-only）
 *
 * 用法：
 *   npx tsx m2-w0-check.ts --snapshot-only     # 只采集安装前基线
 *   npx tsx m2-w0-check.ts                     # 安装后跑完整 12 项 + 工具兼容性
 *
 * 判定（Go / No-Go）：
 *   GO           文件/网络/进程隔离全部符合预期
 *   CONDITIONAL  基础隔离可用但部分能力不满足威胁模型（需补偿措施）
 *   NO-GO        存在可实际利用的逃逸路径
 */
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  SrtCommandExecutor,
  sandboxPlatformSupported,
} from "../../packages/execution/src/index.js"

const results: Array<[string, boolean | "warn", string]> = []
const record = (id: string, ok: boolean | "warn", detail: string) => {
  results.push([id, ok, detail])
  const tag = ok === "warn" ? "WARN" : ok ? "PASS" : "FAIL"
  console.log(`${tag}  ${id}  | ${detail}`)
}

/** 采集系统基线：沙盒用户、WFP 过滤器、CA、相关服务状态 */
function snapshot(): Record<string, string> {
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true })
    return (r.stdout ?? "") + (r.stderr ?? "")
  }
  return {
    srtUser: run("powershell", ["-NoProfile", "-Command", "Get-LocalUser -Name srt-sandbox -ErrorAction SilentlyContinue | Select-Object -Property Name,Enabled,SID | Format-List"]).trim(),
    wfpFilters: run("powershell", ["-NoProfile", "-Command", "Get-NetFirewallRule -DisplayName '*srt*' -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count"]).trim(),
    caCerts: run("powershell", ["-NoProfile", "-Command", "Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object { $_.Subject -match 'srt|sandbox' } | Select-Object -ExpandProperty Subject"]).trim(),
    nodeVersion: process.version,
    platform: `${process.platform} ${os.release()}`,
  }
}

async function main() {
  if (process.platform !== "win32") {
    console.log(`本脚本针对 Windows（当前 ${process.platform}）。macOS/Linux 请跑 m2-check.ts。`)
    process.exitCode = 2
    return
  }

  const snapshotOnly = process.argv.includes("--snapshot-only")
  const base = snapshot()
  console.log("=== 系统基线 ===")
  for (const [k, v] of Object.entries(base)) console.log(`${k}: ${v || "<空>"}`)
  if (snapshotOnly) {
    console.log("\n基线已采集。安装 srt-win 后再跑本脚本（不带 --snapshot-only）。")
    return
  }

  // 未显式 opt-in 时 SrtCommandExecutor 在 win32 是拒绝的；M2-W0 需要 opt-in
  const executor = new SrtCommandExecutor({ platform: "win32", windowsBackend: "srt-win" })
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pcm-w0-ws-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "pcm-w0-out-"))
  const shell = "cmd.exe"

  try {
    // 探针：先跑一条最简命令，确认后端真的起来了
    const probe = await executor.execute({ command: "echo SANDBOX_PROBE_OK", cwd: workspace, timeoutMs: 60_000 })
    if (probe.blocked || !probe.stdout.includes("SANDBOX_PROBE_OK")) {
      console.log(`\n沙盒未就绪，后续 12 项无法验证：${probe.blockReason ?? probe.stderr.slice(0, 200)}`)
      console.log("\n判定：NO-GO（后端未安装或初始化失败）")
      process.exitCode = 1
      return
    }
    record("W0 后端可用探针", true, `exit=${probe.exitCode}`)

    // ── 1/2 工作区内写 / 工作区外写 ──
    {
      const inside = await executor.execute({
        command: `echo inside > in-ws.txt && type in-ws.txt`,
        cwd: workspace,
        timeoutMs: 60_000,
      })
      const onDisk = await readFile(path.join(workspace, "in-ws.txt"), "utf8").catch(() => "")
      record("W1 工作区内写文件（允许）", inside.exitCode === 0 && onDisk.includes("inside"), `exit=${inside.exitCode} disk=${JSON.stringify(onDisk.trim())}`)

      const target = path.join(outside, "escape.txt")
      const out = await executor.execute({
        command: `echo pwned > "${target}"`,
        cwd: workspace,
        timeoutMs: 60_000,
      })
      const created = await readFile(target, "utf8").catch(() => undefined)
      record(
        "W2 工作区外写文件（拒绝）",
        created === undefined,
        `exit=${out.exitCode} 外部文件=${created === undefined ? "未创建（正确）" : "被创建（逃逸！）"}`,
      )
    }

    // ── 3/4 凭据读取 ──
    {
      const home = os.homedir()
      const ssh = await executor.execute({
        command: `type "${path.join(home, ".ssh", "id_rsa")}" 2>&1`,
        cwd: workspace,
        timeoutMs: 60_000,
      })
      const leaked = /BEGIN (OPENSSH|RSA|PRIVATE) KEY/.test(ssh.stdout + ssh.stderr)
      record("W3 SSH 私钥读取（拒绝）", !leaked, `exit=${ssh.exitCode} leaked=${leaked}`)

      const envFile = path.join(workspace, ".env")
      await writeFile(envFile, "SECRET_TOKEN=super-secret-value\n", "utf8")
      // .env 在工作区内：此处验证"工作区内敏感文件是否按策略可读"。
      // 期望：读得到（策略只 deny 凭据目录）；若要求 deny 需在 denyRead 显式加。
      const envRead = await executor.execute({ command: `type "${envFile}" 2>&1`, cwd: workspace, timeoutMs: 60_000 })
      const envLeaked = envRead.stdout.includes("super-secret-value")
      record(
        "W4 工作区 .env 读取（登记：当前策略允许，是否收紧待定）",
        envLeaked ? "warn" : true,
        `exit=${envRead.exitCode} 可读=${envLeaked}（策略：仅 deny 凭据目录）`,
      )
    }

    // ── 5/6/7 网络 ──
    {
      const direct = await executor.execute({
        command: `powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri https://example.com -TimeoutSec 8 -UseBasicParsing).StatusCode } catch { 'BLOCKED' }"`,
        cwd: workspace,
        timeoutMs: 60_000,
      })
      const blockedNet = /BLOCKED|denied|failed|Unable|refused/i.test(direct.stdout + direct.stderr)
      record("W5 直接访问互联网（拒绝）", blockedNet, `exit=${direct.exitCode} out=${JSON.stringify((direct.stdout + direct.stderr).trim().slice(0, 90))}`)

      // 白名单域名的验证需要按命令注入 allowlist（M2.2 能力）；此处登记为待验证
      record(
        "W6 白名单域名访问（待 M2.2 注入能力）",
        "warn",
        "当前配置 allowedDomains 为空；按命令白名单需接 SandboxPolicyInput.allowedDomains 后验证",
      )
      record(
        "W7 未授权域名访问（拒绝）",
        blockedNet,
        "与 W5 同一条探针（example.com 非白名单）",
      )
    }

    // ── 8/9/10 进程生命周期 ──
    {
      const t0 = Date.now()
      const timeout = await executor.execute({
        // 启动子进程并挂起，验证超时能回收整棵进程树
        command: `powershell -NoProfile -Command "Start-Process -NoNewWindow cmd -ArgumentList '/c','timeout /t 60 >nul'; timeout /t 60 >nul"`,
        cwd: workspace,
        timeoutMs: 3000,
      })
      const elapsed = Date.now() - t0
      const leftovers = countProcess("timeout.exe") + countProcess("cmd.exe") - countBaselineCmd()
      record(
        "W8 超时杀死子进程树（全部回收）",
        timeout.timedOut === true && leftovers <= 0,
        `timedOut=${timeout.timedOut} elapsed=${elapsed}ms 残留=${leftovers}`,
      )

      const controller = new AbortController()
      setTimeout(() => controller.abort(), 1500)
      const t1 = Date.now()
      const aborted = await executor.execute({
        command: `powershell -NoProfile -Command "timeout /t 60 >nul"`,
        cwd: workspace,
        timeoutMs: 60_000,
        signal: controller.signal,
      })
      record(
        "W9 AbortSignal 回收（全部回收）",
        aborted.blocked === true && Date.now() - t1 < 30_000,
        `blocked=${aborted.blocked} elapsed=${Date.now() - t1}ms`,
      )

      record(
        "W10 父 Host 崩溃 -> 子进程终止",
        "warn",
        "需人工验证：任务管理器结束 sandbox-host 进程后检查 cmd/timeout 是否被一并回收（脚本无法稳定构造）",
      )
    }

    // ── 11/12 并行与跨 Session ──
    {
      const wsA = await mkdtemp(path.join(os.tmpdir(), "pcm-w0-a-"))
      const wsB = await mkdtemp(path.join(os.tmpdir(), "pcm-w0-b-"))
      try {
        const [ra, rb] = await Promise.all([
          executor.execute({ command: `echo A > only-a.txt && type only-a.txt`, cwd: wsA, timeoutMs: 60_000 }),
          executor.execute({ command: `echo B > only-b.txt && type only-b.txt`, cwd: wsB, timeoutMs: 60_000 }),
        ])
        const crossA = await readFile(path.join(wsA, "only-b.txt"), "utf8").catch(() => undefined)
        const crossB = await readFile(path.join(wsB, "only-a.txt"), "utf8").catch(() => undefined)
        record(
          "W11 两个项目并行执行（写权限不串扰）",
          ra.exitCode === 0 && rb.exitCode === 0 && crossA === undefined && crossB === undefined,
          `ra=${ra.exitCode} rb=${rb.exitCode} crossA=${crossA ?? "无"} crossB=${crossB ?? "无"}`,
        )

        // 跨 Session 读：Windows 的 allowWrite 根目录授权可能跨 Session 保留
        const readCross = await executor.execute({
          command: `type "${path.join(wsA, "only-a.txt")}" 2>&1`,
          cwd: wsB,
          timeoutMs: 60_000,
        })
        const readable = readCross.stdout.includes("A")
        record(
          "W12 跨 Session 读取他项目（需符合隔离策略）",
          readable ? "warn" : true,
          `从 wsB 读 wsA 文件：${readable ? "可读（Windows Session 级授权，需评估）" : "不可读"}`,
        )
      } finally {
        await rm(wsA, { recursive: true, force: true })
        await rm(wsB, { recursive: true, force: true })
      }
    }

    // ── 开发工具兼容性（运行身份改变后工具是否可用） ──
    console.log("\n=== 开发工具兼容性（关键：沙盒用户身份是否能跑通实际工具链） ===")
    const tools: Array<[string, string]> = [
      ["PowerShell", `powershell -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"`],
      ["CMD", `cmd /c ver`],
      ["Node.js", `node --version`],
      ["npm", `npm --version`],
      ["Git", `git --version`],
      ["Python", `python --version 2>&1 || py --version 2>&1`],
    ]
    for (const [name, command] of tools) {
      const r = await executor.execute({ command, cwd: workspace, timeoutMs: 60_000 })
      record(
        `TOOL ${name}`,
        r.exitCode === 0 ? true : "warn",
        `exit=${r.exitCode} out=${JSON.stringify((r.stdout + r.stderr).trim().slice(0, 70))}`,
      )
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }

  // ── 判定 ──
  const fail = results.filter(([, ok]) => ok === false)
  const warn = results.filter(([, ok]) => ok === "warn")
  console.log("\n=== 判定 ===")
  console.log(`PASS ${results.length - fail.length - warn.length} / WARN ${warn.length} / FAIL ${fail.length}`)
  if (fail.length > 0) {
    console.log("NO-GO：存在未通过的隔离项，逐条核对上方 FAIL 明细")
    for (const [id, , d] of fail) console.log(`  - ${id}: ${d}`)
    process.exitCode = 1
  } else if (warn.length > 0) {
    console.log("CONDITIONAL：基础隔离通过，但存在需按威胁模型评估的项")
    for (const [id, , d] of warn) console.log(`  - ${id}: ${d}`)
    process.exitCode = 0
  } else {
    console.log("GO：文件/网络/进程隔离全部符合预期")
    process.exitCode = 0
  }
  console.log(`\n是否支持平台（SRT 视角）: ${sandboxPlatformSupported()}`)
}

function countProcess(name: string): number {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Name '${name.replace(/\.exe$/, "")}' -ErrorAction SilentlyContinue | Measure-Object).Count`], { encoding: "utf8" })
  return Number((r.stdout ?? "").trim()) || 0
}

function countBaselineCmd(): number {
  return 0
}

void main().catch((e) => {
  console.error("M2-W0 脚本崩溃:", e)
  process.exitCode = 2
})
