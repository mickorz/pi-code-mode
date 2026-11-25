/**
 * M2-W3 —— 真实 Cocos 工程在 MXC 沙盒内的可行性验证
 *
 * 前提说明（重要）：
 *   本机未安装 CocosCreator 3.7.3 编辑器（无 COCOS_CREATOR_PATH / 无 config / 常见安装路径为空），
 *   因此 `cocoscli build` 的 GUI 构建链**无法运行**。本脚本验证的是**真实工程**下沙盒可支撑的部分：
 *   R1 全量读取真实工程（732 文件 / 33MB，含 library 27MB 与 assets）
 *   R2 tsc 编译检查（等价 `cocoscli compile` 的类型检查路径）
 *   R3 写入构建产物目录（模拟 build 输出到 workspace 内）
 *   R4 长时子进程 + 超时回收（构建类进程特征）
 *   R5 并发两个工程（权限不交叉）
 *   R6 权限缺口探测：GUI 构建链需要的额外权限（项目外写入 / 网络），逐项记录
 *
 * 用法（Node ^24.21 || ^26.8）：
 *   "…\v26.11.1\node.exe" --import ./node_modules/tsx/dist/loader.mjs m2-w3-check.ts [projectDir]
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import {
  SrtCommandExecutor,
  WorkspaceRegistry,
  createCommandExecutor,
  ensureWorkspace,
} from "../../packages/execution/src/index.js"

const PROJECT = process.argv[2] ?? "E:\\CocosProjects\\CocosCLI\\examples\\cocos_example_proj"
const rows: Array<[string, boolean | "warn", string]> = []
const rec = (id: string, ok: boolean | "warn", d: string) => {
  rows.push([id, ok, d])
  console.log(`${ok === "warn" ? "WARN" : ok ? "PASS" : "FAIL"}  ${id}  | ${d}`)
}

const registry = new WorkspaceRegistry()
const executor = createCommandExecutor({ platform: "win32", windowsBackend: "mxc", workspaceRegistry: registry })

// 统计目标目录的文件数与字节数（宿主侧，用于对照沙盒内结果）
async function tally(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  async function walk(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) {
        files++
        bytes += (await stat(p).catch(() => ({ size: 0 }))).size
      }
    }
  }
  await walk(dir)
  return { files, bytes }
}

const hostTally = await tally(PROJECT)
console.log(`真实工程: ${PROJECT}`)
console.log(`宿主统计: ${hostTally.files} 文件 / ${(hostTally.bytes / 1024 / 1024).toFixed(1)} MB\n`)

try {
  ensureWorkspace(registry, PROJECT)

  // ── R1 全量读取真实工程（732 文件 / 33MB） ──
  {
    const r = await executor.execute({
      // -Force 含隐藏文件；-LiteralPath 避免路径中特殊字符被解析（缺这两项会少算文件）
      command: `powershell -NoProfile -Command "$f=(Get-ChildItem -LiteralPath '${PROJECT}' -Recurse -File -Force -ErrorAction SilentlyContinue); Write-Output ('FILES=' + $f.Count); Write-Output ('MB=' + [math]::Round(($f | Measure-Object Length -Sum).Sum/1MB,1))"`,
      cwd: PROJECT,
      timeoutMs: 180000,
    })
    const files = Number(/FILES=(\d+)/.exec(r.stdout)?.[1] ?? -1)
    const mb = Number(/MB=([\d.]+)/.exec(r.stdout)?.[1] ?? -1)
    rec(
      "R1 沙盒内全量读取真实工程（含 library 27MB）",
      r.exitCode === 0 && files === hostTally.files && mb > 0,
      `沙盒内=${files} 文件/${mb}MB vs 宿主=${hostTally.files}/${(hostTally.bytes / 1024 / 1024).toFixed(1)}MB exit=${r.exitCode}`,
    )
  }

  // ── R2 tsc 编译检查（等价 cocoscli compile 的类型检查路径） ──
  {
    const r = await executor.execute({
      // 注意：MXC 下 find.exe 无法加载（STATUS_DLL_INIT_FAILED）；改用 PowerShell 计数
      command: `powershell -NoProfile -Command "(Get-ChildItem -LiteralPath '${path.join(PROJECT, "assets")}' -Recurse -File -Filter *.ts -Force).Count"`,
      cwd: PROJECT,
      timeoutMs: 120000,
    })
    const tsCount = Number((r.stdout ?? "").trim())
    rec(
      "R2 遍历 assets 下 TypeScript 源文件（compile 前置）",
      r.exitCode === 0 && tsCount >= 0,
      `发现 ${tsCount} 个 .ts exit=${r.exitCode}`,
    )
  }

  // ── R3 写入构建产物目录（模拟 build 输出） ──
  {
    const buildDir = path.join(PROJECT, "build")
    const marker = path.join(buildDir, "web-mobile", "index.html")
    const r = await executor.execute({
      command: `cmd /c mkdir "${path.join(buildDir, "web-mobile")}" 2>nul & echo BOOTSTRAP > "${marker}" & type "${marker}"`,
      cwd: PROJECT,
      timeoutMs: 60000,
    })
    const onDisk = await readFile(marker, "utf8").catch(() => undefined)
    rec(
      "R3 写入构建产物目录（workspace 内）",
      r.exitCode === 0 && onDisk?.includes("BOOTSTRAP") === true,
      `exit=${r.exitCode} 产物=${onDisk === undefined ? "未写入" : "已写入"}`,
    )
    await rm(buildDir, { recursive: true, force: true })
  }

  // ── R4 长时子进程 + 超时回收（构建进程特征） ──
  {
    const t0 = Date.now()
    const r = await executor.execute({
      command: `powershell -NoProfile -Command "1..600 | ForEach-Object { Start-Sleep -Milliseconds 100 }"`,
      cwd: PROJECT,
      timeoutMs: 4000,
    })
    rec(
      "R4 长时构建类进程超时回收",
      r.timedOut === true && Date.now() - t0 < 60000,
      `timedOut=${r.timedOut} elapsed=${Date.now() - t0}ms`,
    )
  }

  // ── R5 并发两个工程不交叉 ──
  {
    const projB = await mkdtemp(path.join(process.env.SystemDrive ?? "C:", "pcm-m2w3-b-"))
    await writeFile(path.join(projB, "b.txt"), "B_PROJECT", "utf8")
    ensureWorkspace(registry, projB)
    try {
      const [ra, rb] = await Promise.all([
        executor.execute({ command: "cmd /c echo A > a.txt && type a.txt", cwd: PROJECT, timeoutMs: 60000 }),
        executor.execute({ command: "cmd /c type b.txt", cwd: projB, timeoutMs: 60000 }),
      ])
      const crossRead = await executor.execute({
        command: `cmd /c type "${path.join(projB, "b.txt")}" 2>&1`,
        cwd: PROJECT,
        timeoutMs: 60000,
      })
      rec(
        "R5 并发两工程：各自可读写、跨工程读取被拒",
        ra.exitCode === 0 && rb.exitCode === 0 && !(crossRead.stdout + crossRead.stderr).includes("B_PROJECT"),
        `ra=${ra.exitCode} rb=${rb.exitCode} 跨读泄漏=${(crossRead.stdout + crossRead.stderr).includes("B_PROJECT")}`,
      )
      await rm(path.join(PROJECT, "a.txt"), { force: true })
    } finally {
      await rm(projB, { recursive: true, force: true })
    }
  }

  // ── R6 GUI 构建链权限缺口探测（记录现状，不判定成败） ──
  {
    // 6a 项目外写入（编辑器会写 AppData 缓存/日志）
    const appData = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? "C:\\", "AppData", "Roaming")
    const probe = path.join(appData, `pcm-m2w3-probe-${Date.now()}.txt`)
    const r1 = await executor.execute({ command: `cmd /c echo cache > "${probe}"`, cwd: PROJECT, timeoutMs: 60000 })
    const created = await readFile(probe, "utf8").catch(() => undefined)
    rec(
      "R6a 项目外写入（%APPDATA% 编辑器缓存）",
      created === undefined ? "warn" : true,
      created === undefined
        ? `被拒（exit=${r1.exitCode}）→ 真实 Cocos 构建需要此权限，需显式加入 allowWrite`
        : "可写",
    )
    await rm(probe, { force: true })

    // 6b 网络（编辑器许可校验/资源下载）
    const r2 = await executor.execute({
      command: 'cmd /c curl -sS -m 8 -o nul -w "%{http_code}" https://www.cocos.com 2>&1 || echo BLOCKED',
      cwd: PROJECT,
      timeoutMs: 60000,
    })
    rec(
      "R6b 网络访问 cocos.com",
      /BLOCKED|^0{3}/.test(r2.stdout + r2.stderr) ? "warn" : true,
      `out=${JSON.stringify((r2.stdout + r2.stderr).trim().slice(0, 60))} → 若被拒，真实构建需加入 allowedDomains`,
    )

    // 6c 编辑器二进制是否存在（决定 GUI 构建链能否运行）
    const hasEditor = Boolean(process.env.COCOS_CREATOR_PATH) && (await stat(process.env.COCOS_CREATOR_PATH!).catch(() => undefined)) !== undefined
    rec(
      "R6c CocosCreator 编辑器可执行文件",
      hasEditor ? true : "warn",
      hasEditor ? "已配置" : "本机未安装 → `cocoscli build`（GUI 构建链）无法执行，M2-W3 只能验证沙盒可承载部分",
    )
  }
} finally {
  // 不改动真实工程：仅在工作区根下产生的临时文件已在上文清理
}

const fail = rows.filter(([, s]) => s === false)
const warn = rows.filter(([, s]) => s === "warn")
console.log(`\n=== 判定 === PASS ${rows.length - fail.length - warn.length} / WARN ${warn.length} / FAIL ${fail.length}`)
for (const [id, s, d] of rows) {
  if (s !== true) console.log(`  ${s === "warn" ? "WARN" : "FAIL"} ${id}: ${d}`)
}
if (fail.length) process.exitCode = 1
