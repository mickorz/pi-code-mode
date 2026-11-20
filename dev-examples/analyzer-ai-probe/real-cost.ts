import { DefaultResourceLoader, SettingsManager, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent"
import fs from "node:fs"; import os from "node:os"; import path from "node:path"
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent"); const CWD = process.cwd()
const FULL = fs.readFileSync("dev-examples/analyzer-ai-probe/last-prompt.txt", "utf8")
const LIMIT = Number(process.argv[2] ?? 240) * 1000
async function run(model) {
  const loader = new DefaultResourceLoader({ cwd: CWD, agentDir: AGENT_DIR, noExtensions: true }); await loader.reload()
  const opts = { cwd: CWD, agentDir: AGENT_DIR, sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.create(CWD, AGENT_DIR), resourceLoader: loader }
  const { session: s } = await createAgentSession(model ? { ...opts, model } : opts)
  let chars = 0
  s.subscribe?.((e) => { if (e.type === "message_end" && e.message?.role === "assistant") for (const c of e.message.content ?? []) if (c.type === "text") chars += c.text.length })
  let aborted = false; const t0 = Date.now()
  const k = setTimeout(() => { aborted = true; void s.abort() }, LIMIT)
  try { await s.prompt(FULL); console.log(`${aborted?"[超时]":"[OK]  "} model=${model ?? "(default)"} | ${String(Date.now()-t0).padStart(6)}ms | ${chars}字`) }
  catch (e) { console.log(`[异常] model=${model ?? "(default)"} | ${Date.now()-t0}ms | ${String(e?.message ?? e).slice(0,60)}`) }
  finally { clearTimeout(k); try { s.dispose?.() } catch {} }
}
await run(undefined)
process.exit(0)
