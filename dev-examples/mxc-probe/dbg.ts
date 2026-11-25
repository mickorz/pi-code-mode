import { mkdir, mkdtemp } from "node:fs/promises"
import path from "node:path"
import { SrtCommandExecutor } from "../../packages/execution/src/index.js"
const base = path.join(process.env.SystemDrive ?? "C:", "pcm-m2w0b")
await mkdir(base, { recursive: true })
const ws = await mkdtemp(path.join(base, "dbg-"))
const ex = new SrtCommandExecutor({ windowsBackend: "mxc" })
const r = await ex.execute({ command: "cmd /c echo hi", cwd: ws, timeoutMs: 30000 })
console.log(JSON.stringify(r, null, 2).slice(0, 1500))
