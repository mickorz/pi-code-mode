import { DefaultResourceLoader, SettingsManager, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent"
import fs from "node:fs"; import os from "node:os"; import path from "node:path"
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent"); const CWD = process.cwd()
const FULL = fs.readFileSync("dev-examples/analyzer-ai-probe/last-prompt.txt", "utf8")
const loader = new DefaultResourceLoader({ cwd: CWD, agentDir: AGENT_DIR, noExtensions: true }); await loader.reload()
const { session: s } = await createAgentSession({ cwd: CWD, agentDir: AGENT_DIR, sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.create(CWD, AGENT_DIR), resourceLoader: loader })
let text = ""; let fc = 0
const t1 = Date.now()
s.subscribe?.((e) => {
  const ev = e
  if (!fc) { fc = 1; console.log(`首个事件 @${Date.now()-t1}ms type=${ev.type}`) }
  if (ev.type === "message_delta") { const d = ev.delta; text += (typeof d === "string" ? d : (d?.text ?? "")) }
  if (ev.type === "message_end" && ev.message?.role === "assistant") for (const c of ev.message.content ?? []) if (c.type === "text") text += c.text
})
const t0 = Date.now()
const k = setTimeout(() => { console.log(`[120s 快照] 已生成 ${text.length} 字`); console.log(text.slice(-800)); void s.abort() }, 120_000)
await s.prompt(FULL)
clearTimeout(k)
console.log(`耗时 ${Date.now()-t0}ms | 输出 ${text.length} 字`)
console.log("========== 输出全文 ==========")
console.log(text.slice(0, 3000))
process.exit(0)
