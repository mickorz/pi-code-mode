import { DefaultResourceLoader, SettingsManager, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent"
import fs from "node:fs"; import os from "node:os"; import path from "node:path"
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent"); const CWD = process.cwd()
const FULL = fs.readFileSync("dev-examples/analyzer-ai-probe/last-prompt.txt", "utf8")
const HEAD = FULL.slice(0, FULL.indexOf("## "))
const FINDINGS = FULL.slice(FULL.indexOf("## Findings"), FULL.lastIndexOf("输出 JSON"))
const LIMIT = Number(process.argv[2] ?? 150) * 1000

const LEAN = `${HEAD}
## 分析数据（静态分析已确定，不要重新分析）
${FINDINGS.trim()}

## 输出要求
最多 3 条建议。输出一个 JSON 对象，严格照抄此结构：
{"analysisSummary":"一句话","proposals":[{"id":"OPT-001","title":"标题","severity":"medium","target":{"startLine":1,"endLine":2},"problem":"问题","proposal":{"type":"parallel","action":"动作"},"dependencyAnalysis":"依赖","expectedImpact":{"note":"待 Benchmark"},"qualityRisk":"low","validation":["验收1"]}]}
只输出 JSON，不要 markdown 围栏，不要解释。`

async function runOne(name, prompt, thinking) {
  const loader = new DefaultResourceLoader({ cwd: CWD, agentDir: AGENT_DIR, noExtensions: true }); await loader.reload()
  const base = { cwd: CWD, agentDir: AGENT_DIR, sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.create(CWD, AGENT_DIR), resourceLoader: loader }
  const { session: s } = await createAgentSession(thinking ? { ...base, thinkingLevel: thinking } : base)
  let chars = 0; s.subscribe?.((e) => { if (e.type === "message_end" && e.message?.role === "assistant") for (const c of e.message.content ?? []) if (c.type === "text") chars += c.text.length })
  let aborted = false; const t0 = Date.now()
  const k = setTimeout(() => { aborted = true; void s.abort() }, LIMIT)
  try { await s.prompt(prompt); console.log(`${aborted?"[超时]":"[OK]  "} ${name} | ${prompt.length}字符 | ${String(Date.now()-t0).padStart(6)}ms | ${chars}字`) }
  catch (e) { console.log(`[异常] ${name} | ${Date.now()-t0}ms | ${String(e?.message ?? e).slice(0,50)}`) }
  finally { clearTimeout(k); try { s.dispose?.() } catch {} }
}
await runOne("L1 精简(findings+示例+限3条)", LEAN)
await runOne("L2 精简 + thinking=low", LEAN, "low")
process.exit(0)
