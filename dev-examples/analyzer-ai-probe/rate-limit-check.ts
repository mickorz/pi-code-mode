import { DefaultResourceLoader, SettingsManager, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent"
import os from "node:os"; import path from "node:path"; import fs from "node:fs"
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent"); const CWD = process.cwd()
const FULL = fs.readFileSync("dev-examples/analyzer-ai-probe/last-prompt.txt", "utf8")
async function run(name, prompt, limit = 70000) {
  const loader = new DefaultResourceLoader({ cwd: CWD, agentDir: AGENT_DIR, noExtensions: true }); await loader.reload()
  const { session: s } = await createAgentSession({ cwd: CWD, agentDir: AGENT_DIR, sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.create(CWD, AGENT_DIR), resourceLoader: loader })
  let n = 0; let firstDelta = 0
  const t0 = Date.now()
  s.subscribe?.((e) => { if (!firstDelta && e.type === "message_delta") firstDelta = Date.now()-t0; if (e.type === "message_end" && e.message?.role === "assistant") for (const c of e.message.content ?? []) if (c.type === "text") n += c.text.length })
  let ab = false; const k = setTimeout(() => { ab = true; void s.abort() }, limit)
  try { await s.prompt(prompt); console.log(`${ab?"[超时]":"[OK]  "} ${name} | ${String(Date.now()-t0).padStart(6)}ms | ${n}字 | 首delta ${firstDelta||"-"}ms`) }
  catch (e) { console.log(`[异常] ${name} | ${Date.now()-t0}ms`) }
  finally { clearTimeout(k); try { s.dispose?.() } catch {} }
}
console.log("冷却 90s ...")
await new Promise((r) => setTimeout(r, 90_000))
await run("冷却后: 只回复ok", "只回复 ok", 30000)
await run("冷却后: 224字符JSON约束", FULL.slice(FULL.lastIndexOf("输出 JSON")), 70000)
await run("冷却后: 完整prompt", FULL, 120000)
process.exit(0)
