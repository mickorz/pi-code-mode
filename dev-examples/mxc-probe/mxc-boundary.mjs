/**
 * M2-W0b —— MXC BaseContainer 边界实测（修正版）
 *
 * 修正前一版的三处方法学错误：
 *   1. 工作区不能放 %TEMP%：SRT 的 buildMxcRequest 无条件把宿主机 %TEMP% 加入
 *      readwritePaths（源码 sandbox-utils/mxc-sandbox-utils.js 第 276-279 行），
 *      在 temp 里测"工作区外写"必然误判为逃逸。
 *   2. 凭据测试不该依赖用户真实 ~/.ssh 内容；用受控的 secret 目录做 denyRead 验证。
 *   3. timeout.exe 在 MXC 下 STATUS_DLL_INIT_FAILED；用 node 做长驻进程。
 *
 * 运行要求：Node >= 24.21.0（24 线）或 >= 26.8.0；MXC 原生 stdio 依赖此版本。
 *   "C:\Users\<you>\AppData\Local\nvm\v26.11.1\node.exe" mxc-boundary.mjs
 */
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'

const results = []
const record = (id, status, detail) => {
  results.push([id, status, detail])
  const tag = status === 'warn' ? 'WARN' : status ? 'PASS' : 'FAIL'
  console.log(`${tag}  ${id}  | ${detail}`)
}

// 全部放在 %TEMP% 之外：C:\pcm-m2w0b\<随机>
const base = path.join(process.env.SystemDrive ?? 'C:', 'pcm-m2w0b')
await mkdir(base, { recursive: true })
const root = await mkdtemp(path.join(base, 'run-'))
const workspace = path.join(root, 'workspace')
const outside = path.join(root, 'outside')
const secret = path.join(root, 'secret')
await mkdir(workspace, { recursive: true })
await mkdir(outside, { recursive: true })
await mkdir(secret, { recursive: true })
await writeFile(path.join(secret, 'token.txt'), 'TOP_SECRET_TOKEN_12345', 'utf8')

const cfg = {
  windows: { backend: 'mxc' },
  network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
  filesystem: {
    allowWrite: [{ path: workspace, literal: true }],
    denyRead: [{ path: secret, literal: true }],
    allowRead: [],
    denyWrite: [],
    allowGitConfig: false,
  },
}

async function run(command, cwd, timeoutMs = 30000) {
  const p = await SandboxManager.spawnSandboxed(command, {
    cwd,
    commandId: `w0b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timeoutMs,
  })
  let out = ''
  let err = ''
  p.stdout?.on('data', (c) => { out += c.toString() })
  p.stderr?.on('data', (c) => { err += c.toString() })
  const r = await p.wait()
  return { ...r, stdout: out, stderr: err }
}

try {
  await SandboxManager.initialize(cfg, undefined, false)
  console.log(`后端: ${JSON.stringify(SandboxManager.getWindowsBackend?.())}`)
  console.log(`工作区: ${workspace}\n外部: ${outside}\n秘密: ${secret}\n`)

  // W1 工作区内写
  {
    const r = await run('cmd /c echo inside-ok > in-ws.txt && type in-ws.txt', workspace)
    const disk = await readFile(path.join(workspace, 'in-ws.txt'), 'utf8').catch(() => '')
    record('W1 工作区内写入（允许）', r.exitCode === 0 && disk.includes('inside-ok'), `exit=${r.exitCode} disk=${JSON.stringify(disk.trim())}`)
  }

  // W2 工作区外写（核心，已在 %TEMP% 之外）
  {
    const target = path.join(outside, 'escape.txt')
    const r = await run(`cmd /c echo pwned > "${target}"`, workspace)
    const created = await readFile(target, 'utf8').catch(() => undefined)
    record(
      'W2 工作区外写入（必须拒绝）',
      created === undefined,
      `exit=${r.exitCode} 外部文件=${created === undefined ? '未创建（正确）' : '被创建（逃逸！）'} out=${JSON.stringify((r.stdout + r.stderr).trim().slice(0, 90))}`,
    )
    await rm(target, { force: true })
  }

  // W3 denyRead 秘密文件（核心）
  {
    const r = await run(`cmd /c type "${path.join(secret, 'token.txt')}" 2>&1`, workspace)
    const leaked = (r.stdout + r.stderr).includes('TOP_SECRET_TOKEN_12345')
    record('W3 denyRead 秘密文件内容（必须拒绝）', !leaked, `exit=${r.exitCode} leaked=${leaked} out=${JSON.stringify((r.stdout + r.stderr).trim().slice(0, 90))}`)
  }

  // W3b denyRead 目录枚举
  {
    const r = await run(`cmd /c dir "${secret}" 2>&1`, workspace)
    const listed = (r.stdout + r.stderr).includes('token.txt')
    record('W3b denyRead 目录枚举（宜拒绝）', listed ? 'warn' : true, `exit=${r.exitCode} 列出内容=${listed}`)
  }

  // W4 网络默认拒绝
  {
    const r = await run('cmd /c curl -sS -m 8 -o nul -w "%{http_code}" https://example.com 2>&1 || echo CURL_FAILED', workspace)
    const txt = r.stdout + r.stderr
    record('W4 网络默认拒绝', /CURL_FAILED|^000|denied|refused|failed/i.test(txt), `exit=${r.exitCode} out=${JSON.stringify(txt.trim().slice(0, 90))}`)
  }

  // W5 超时（用 node 长驻，不用 timeout.exe）
  {
    const t0 = Date.now()
    const r = await run('node -e "setTimeout(()=>{},60000)"', workspace, 2500)
    record('W5 超时终止 timedOut', r.timedOut === true, `timedOut=${r.timedOut} elapsed=${Date.now() - t0}ms exit=${r.exitCode}`)
  }

  // W6 并行两工作区
  {
    const wsA = path.join(root, 'a')
    const wsB = path.join(root, 'b')
    await mkdir(wsA, { recursive: true })
    await mkdir(wsB, { recursive: true })
    // 注意：Session 级授权下两个 workspace 需要都在 allowWrite 中，否则第二个会被拒绝
    const cfg2 = { ...cfg, filesystem: { ...cfg.filesystem, allowWrite: [{ path: wsA, literal: true }, { path: wsB, literal: true }] } }
    await SandboxManager.reset()
    await SandboxManager.initialize(cfg2, undefined, false)
    const [ra, rb] = await Promise.all([
      run('cmd /c echo A > a.txt && type a.txt', wsA),
      run('cmd /c echo B > b.txt && type b.txt', wsB),
    ])
    const crossA = await readFile(path.join(wsA, 'b.txt'), 'utf8').catch(() => undefined)
    const crossB = await readFile(path.join(wsB, 'a.txt'), 'utf8').catch(() => undefined)
    record('W6 并行两工作区写不串扰', ra.exitCode === 0 && rb.exitCode === 0 && crossA === undefined && crossB === undefined, `ra=${ra.exitCode} rb=${rb.exitCode} crossA=${crossA ?? '无'} crossB=${crossB ?? '无'}`)
  }

  // W7 工具兼容性
  console.log('\n--- 开发工具兼容性 ---')
  const tools = [
    ['CMD', 'cmd /c ver'],
    ['PowerShell', 'powershell -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"'],
    ['Node.js', 'node --version'],
    ['npm', 'npm --version'],
    ['Git(原生)', 'git --version'],
    ['Python', 'python --version 2>&1 || py --version 2>&1'],
    ['Git Bash(MSYS2)', 'bash --version 2>&1'],
  ]
  for (const [name, cmd] of tools) {
    const r = await run(cmd, workspace, 40000)
    const out = (r.stdout + r.stderr).trim().split('\n')[0] ?? ''
    record(`TOOL ${name}`, r.exitCode === 0 ? true : 'warn', `exit=${r.exitCode} ${JSON.stringify(out.slice(0, 70))}`)
  }

  // W8 %TEMP% 可写（登记为已知残余）
  {
    const target = path.join(os.tmpdir(), `pcm-temp-probe-${Date.now()}.txt`)
    const r = await run(`cmd /c echo tempwrite > "${target}"`, workspace)
    const created = await readFile(target, 'utf8').catch(() => undefined)
    record(
      'W8 宿主机 %TEMP% 可写（SRT 设计如此，登记残余）',
      'warn',
      `exit=${r.exitCode} 可写=${created !== undefined}（SRT buildMxcRequest 无条件加入 %TEMP%）`,
    )
    await rm(target, { force: true })
  }
} catch (e) {
  console.log(`\n失败: ${e.constructor?.name} ${String(e.message).slice(0, 400)} ${e.code ?? ''}`)
  process.exitCode = 1
} finally {
  try { SandboxManager.cleanupAfterCommand() } catch {}
  try { await SandboxManager.reset() } catch {}
  await rm(root, { recursive: true, force: true })
}

const fail = results.filter(([, s]) => s === false)
const warn = results.filter(([, s]) => s === 'warn')
console.log(`\n=== 判定 === PASS ${results.length - fail.length - warn.length} / WARN ${warn.length} / FAIL ${fail.length}`)
if (fail.length) {
  console.log('NO-GO：存在隔离失败项')
  for (const [id, , d] of fail) console.log(`  - ${id}: ${d}`)
  process.exitCode = 1
} else if (warn.length) {
  console.log('CONDITIONAL：基础隔离通过，存在需按威胁模型评估项')
  for (const [id, , d] of warn) console.log(`  - ${id}: ${d}`)
} else {
  console.log('GO：文件/网络/进程隔离全部符合预期')
}
