import { DefaultResourceLoader, SettingsManager, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent"
import fs from "node:fs"; import os from "node:os"; import path from "node:path"
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent"); const CWD = process.cwd()
const FULL = fs.readFileSync("dev-examples/analyzer-ai-probe/last-prompt.txt", "utf8")
const V1 = FULL.slice(0, FULL.indexOf("## "))
const V3 = FULL.slice(FULL.lastIndexOf("输出 JSON"))

const ascii = (t) => t.replace(/≥/g, ">=").replace(/≤/g, "<=").replace(/「/g, "'").replace(/」/g, "'").replace(/\*\*/g, "").replace(/：/g, ":")
const variants = [
  ["A1 V1 ASCII化", ascii(V1)],
  ["A2 V3 ASCII化", ascii(V3)],
  ["A3 V1 仅前80字符", V1.slice(0, 80)],
  ["A4 V3 仅前80字符", V3.slice(0, 80)],
]
async function run(name, prompt) {
  const loader = new DefaultResourceLoader({ cwd: CWD, agentDir: AGENT_DIR, noExtensions: true }); await loader.reload()
  const { session } = await createAgentSession({ cwd: CWD, agentDir: AGENT_DIR, sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.create(CWD, AGENT_DIR), resourceLoader: loader })
  const s = session
  let chars = 0
  s.subscribe?.((e) => { const ev = e; if (ev.type === "message_end" && ev.message?.role === "assistant") for (const c of ev.message.content ?? []) if (c.type === "text") chars += c.text.length })
  let aborted = false; const t0 = Date.now()
  const k = setTimeout(() => { aborted = true; void s.abort() }, 45000)
  try { await s.prompt(prompt); console.log(`${aborted?"[超时]":"[OK]  "} ${name} | ${String(prompt.length).padStart(4)}字符 | ${String(Date.now()-t0).padStart(6)}ms | ${chars}字`) }
  catch (e) { console.log(`[异常] ${name} | ${Date.now()-t0}ms | ${String(e?.message ?? e).slice(0,60)}`) }
  finally { clearTimeout(k); try { s.dispose?.() } catch {} }
}
for (const [n, p] of variants) await run(n, p)
process.exit(0)
