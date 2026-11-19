import { DefaultResourceLoader, SettingsManager, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent"
import os from "node:os"; import path from "node:path"
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent"); const CWD = process.cwd()

// 最终候选 prompt：无代码片段、findings 一行一条、JSON 示例代替 schema
const FINAL = `你是 Workflow 性能优化顾问。仅基于下面静态分析摘要提建议，不要重新分析项目，信息不足就说信息不足。

## 分析摘要
文件: 4-client-verify.js | 风险分 2/100 | 调用点 7 | 估算任务量 6（含动态下限）

## 已发现问题
1. SERIAL-002 (medium, 置信度0.40) L301-364: 3 个调用相邻但无数据引用（call-4,5,6），组内含动态节点需语义确认
2. SERIAL-002 (medium, 置信度0.40) L379-412: 2 个调用相邻但无数据引用（call-7,8），需语义确认
3. RETRY-001 (low, 0.80) L66-98: retries 最高 2 次，7 个 agent 调用，最坏调用量 21

## 要求
- 最多 3 条建议，只针对上面列出的问题
- 每条必须说明：能否改、怎么改、怎么验证
- 不得虚构数值收益，没有基准就写「待 Benchmark」
- 只输出 JSON，不要 markdown 围栏，不要解释文字

## 输出格式（照抄这个结构）
{"analysisSummary":"一句话总结","proposals":[{"id":"OPT-001","title":"标题","severity":"medium","target":{"startLine":1,"endLine":2},"problem":"问题","proposal":{"type":"parallel","action":"动作"},"dependencyAnalysis":"依赖","expectedImpact":{"note":"待 Benchmark"},"qualityRisk":"low","validation":["验收1"]}]}`

async function run(name, prompt, limit) {
  const loader = new DefaultResourceLoader({ cwd: CWD, agentDir: AGENT_DIR, noExtensions: true }); await loader.reload()
  const { session: s } = await createAgentSession({ cwd: CWD, agentDir: AGENT_DIR, sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.create(CWD, AGENT_DIR), resourceLoader: loader })
  let n = 0; const t0 = Date.now(); let firstDelta = 0
  s.subscribe?.((e) => { if (!firstDelta && e.type === "message_delta") firstDelta = Date.now()-t0; if (e.type === "message_end" && e.message?.role === "assistant") for (const c of e.message.content ?? []) if (c.type === "text") n += c.text.length })
  let ab = false; const k = setTimeout(() => { ab = true; void s.abort() }, limit)
  try { await s.prompt(prompt); console.log(`${ab?"[超时]":"[OK]  "} ${name} | ${prompt.length}字符 | ${String(Date.now()-t0).padStart(6)}ms | ${n}字 | 首delta ${firstDelta||"-"}ms`) }
  catch (e) { console.log(`[异常] ${name} | ${Date.now()-t0}ms | ${String(e?.message ?? e).slice(0,50)}`) }
  finally { clearTimeout(k); try { s.dispose?.() } catch {} }
}
await run("FINAL 瘦身版", FINAL, 120000)
await run("FINAL 重复验证", FINAL, 120000)
process.exit(0)
