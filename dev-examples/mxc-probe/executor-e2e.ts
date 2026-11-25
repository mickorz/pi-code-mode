/** 走本项目 SrtCommandExecutor(windowsBackend:'mxc') 的端到端验证 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { SrtCommandExecutor } from "../../packages/execution/src/index.js"

const base = path.join(process.env.SystemDrive ?? "C:", "pcm-m2w0b")
await mkdir(base, { recursive: true })
const root = await mkdtemp(path.join(base, "exec-"))
const ws = path.join(root, "ws")
const out = path.join(root, "out")
await mkdir(ws, { recursive: true })
await mkdir(out, { recursive: true })

const executor = new SrtCommandExecutor({ windowsBackend: "mxc" })
const rows: Array<[string, boolean, string]> = []

try {
  const r1 = await executor.execute({ command: "cmd /c echo via-executor > f.txt && type f.txt", cwd: ws, timeoutMs: 40000 })
  const disk = await readFile(path.join(ws, "f.txt"), "utf8").catch(() => "")
  rows.push(["E1 工作区内写（经 executor）", r1.exitCode === 0 && disk.includes("via-executor"), `exit=${r1.exitCode} disk=${JSON.stringify(disk.trim())}`])

  const target = path.join(out, "x.txt")
  const r2 = await executor.execute({ command: `cmd /c echo pwned > "${target}"`, cwd: ws, timeoutMs: 40000 })
  const created = await readFile(target, "utf8").catch(() => undefined)
  rows.push(["E2 工作区外写被拒（经 executor）", created === undefined, `exit=${r2.exitCode} 外部=${created === undefined ? "未创建" : "被创建！"}`])

  const r3 = await executor.execute({ command: "cmd /c curl -sS -m 6 -o nul https://example.com 2>&1 || echo NETBLOCKED", cwd: ws, timeoutMs: 40000 })
  rows.push(["E3 网络默认拒绝（经 executor）", /NETBLOCKED|403|failed|refused/i.test(r3.stdout + r3.stderr), `exit=${r3.exitCode}`])

  const r4 = await executor.execute({ command: 'node -e "setTimeout(()=>{},60000)"', cwd: ws, timeoutMs: 2500 })
  rows.push(["E4 超时回收（经 executor）", r4.timedOut === true, `timedOut=${r4.timedOut} exit=${r4.exitCode}`])

  for (const [id, ok, d] of rows) console.log(`${ok ? "PASS" : "FAIL"}  ${id}  | ${d}`)
  const failed = rows.filter(([, ok]) => !ok).length
  console.log(failed ? `\n失败 ${failed} 项` : "\nexecutor 端到端全部通过")
  process.exitCode = failed ? 1 : 0
} finally {
  await rm(root, { recursive: true, force: true })
}
