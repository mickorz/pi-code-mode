/**
 * 修复假设验证：thinkingLevel 降低 + 输出格式改「示例」而非「schema 描述」
 *
 * 变体：
 *  T1 原 schema 描述 + thinking low
 *  T2 示例格式 + thinking low
 *  T3 示例格式 + 默认 thinking
 */
import { DefaultResourceLoader, SettingsManager, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent")
const CWD = process.cwd()
const FULL = fs.readFileSync(path.join(import.meta.dirname, "last-prompt.txt"), "utf8")
const HEAD = FULL.slice(0, FULL.indexOf("## "))
const SCHEMA_CLAUSE = FULL.slice(FULL.lastIndexOf("输出 JSON"))
const LIMIT = 90_000

/** 用示例代替 schema 描述 */
const EXAMPLE_CLAUSE = `输出一个 JSON 对象，格式示例（照抄这个结构，值按实际分析填写）：
{"analysisSummary":"一句话总结","proposals":[{"id":"OPT-001","title":"建议标题","severity":"medium","target":{"startLine":10,"endLine":20},"problem":"问题说明","proposal":{"type":"parallel","action":"改成并行"},"dependencyAnalysis":"为什么能改","expectedImpact":{"note":"待 Benchmark"},"qualityRisk":"low","validation":["验收条件1"]}]}
只输出 JSON，不要解释，不要 markdown 围栏。`

interface Case {
  name: string
  prompt: string
  thinking?: string
}

const cases: Case[] = [
  { name: "T1 schema描述 + thinking=low", prompt: HEAD + SCHEMA_CLAUSE, thinking: "low" },
  { name: "T2 示例格式 + thinking=low", prompt: HEAD + EXAMPLE_CLAUSE, thinking: "low" },
  { name: "T3 示例格式 + 默认thinking", prompt: HEAD + EXAMPLE_CLAUSE },
]

async function runOne(c: Case): Promise<void> {
  const loader = new DefaultResourceLoader({ cwd: CWD, agentDir: AGENT_DIR, noExtensions: true })
  await loader.reload()
  const base = {
    cwd: CWD,
    agentDir: AGENT_DIR,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.create(CWD, AGENT_DIR),
    resourceLoader: loader,
  }
  const { session: s } = await createAgentSession(
    c.thinking ? { ...base, thinkingLevel: c.thinking as never } : base,
  )
  let chars = 0
  let firstText = 0
  const t0 = Date.now()
  s.subscribe?.((e: any) => {
    if (e.type === "message_end" && e.message?.role === "assistant") {
      for (const x of e.message.content ?? []) if (x.type === "text") chars += x.text.length
    }
    if (!firstText && e.type === "message_delta") firstText = Date.now() - t0
  })
  let aborted = false
  const k = setTimeout(() => {
    aborted = true
    void s.abort()
  }, LIMIT)
  try {
    await s.prompt(c.prompt)
    console.log(`${aborted ? "[超时]" : "[OK]  "} ${c.name} | ${String(Date.now() - t0).padStart(6)}ms | ${chars}字 | 首字 ${firstText || "-"}ms`)
  } catch (e) {
    console.log(`[异常] ${c.name} | ${Date.now() - t0}ms | ${String((e as Error)?.message ?? e).slice(0, 60)}`)
  } finally {
    clearTimeout(k)
    try {
      ;(s as any).dispose?.()
    } catch {
      /* 忽略 */
    }
  }
}

for (const c of cases) await runOne(c)
process.exit(0)
