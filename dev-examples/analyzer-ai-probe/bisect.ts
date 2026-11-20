/**
 * prompt 二分探针：定位 planner prompt 里哪部分让服务端 120s 无响应
 *
 * 每个变体独立 session、独立超时，串行执行（避免并发干扰）。
 * 用法：npx tsx dev-examples/analyzer-ai-probe/bisect.ts
 */
import { DefaultResourceLoader, SettingsManager, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent")
const CWD = process.cwd()
const FULL = fs.readFileSync(path.join(import.meta.dirname, "last-prompt.txt"), "utf8")
const TIMEOUT_MS = 60_000

/** 取最后一个 "输出 JSON" 约束段（从最后一个 '输出 JSON' 开始到结尾） */
function outputClause(): string {
  const i = FULL.lastIndexOf("输出 JSON")
  return i >= 0 ? FULL.slice(i) : ""
}
/** 报告摘要 + findings 段（不含代码片段与输出约束） */
function reportPart(): string {
  const s = FULL.indexOf("## 分析报告摘要")
  const e = FULL.indexOf("输出 JSON")
  return s >= 0 ? FULL.slice(s, e >= 0 ? e : undefined) : ""
}
/** 代码片段段（``` 围栏内） */
function codePart(): string {
  const m = /```[\s\S]*?```/g
  return (FULL.match(m) ?? []).join("\n")
}
/** 指令头（第一个 ## 之前） */
function instructionPart(): string {
  const i = FULL.indexOf("## ")
  return i > 0 ? FULL.slice(0, i) : ""
}

interface Variant {
  name: string
  prompt: string
}

const variants: Variant[] = [
  { name: "C1 对照组: 只回复ok", prompt: "只回复 ok" },
  { name: "C2 对照组: 输出JSON小对象", prompt: '只输出一个 JSON 对象：{"ok":true}' },
  { name: "V0 完整 (基线)", prompt: FULL },
  { name: "V1 仅指令头", prompt: instructionPart() },
  { name: "V2 指令头+报告摘要", prompt: instructionPart() + reportPart() },
  { name: "V3 仅输出JSON约束", prompt: outputClause() },
  { name: "V4 完整但去代码片段", prompt: FULL.replace(codePart(), "") },
]

async function runOne(v: Variant): Promise<void> {
  const loader = new DefaultResourceLoader({ cwd: CWD, agentDir: AGENT_DIR, noExtensions: true })
  await loader.reload()
  const created = await createAgentSession({
    cwd: CWD,
    agentDir: AGENT_DIR,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.create(CWD, AGENT_DIR),
    resourceLoader: loader,
  })
  const session = created.session as unknown as {
    prompt: (t: string) => Promise<unknown>
    abort: () => Promise<void>
    subscribe?: (cb: (e: unknown) => void) => () => void
    dispose?: () => void
  }

  let chars = 0
  const t0 = Date.now()
  session.subscribe?.((e: unknown) => {
    const ev = e as Record<string, any>
    if (ev.type === "message_end" && ev.message?.role === "assistant") {
      for (const c of ev.message.content ?? []) if (c.type === "text") chars += c.text.length
    }
  })

  let aborted = false
  const killer = setTimeout(() => {
    aborted = true
    void session.abort()
  }, TIMEOUT_MS)

  try {
    await session.prompt(v.prompt)
    const ms = Date.now() - t0
    console.log(`${aborted ? "[超时]" : "[OK]  "} ${v.name} | ${String(v.prompt.length).padStart(5)} 字符 | ${String(ms).padStart(6)}ms | 输出 ${chars} 字`)
  } catch (e) {
    console.log(`[异常] ${v.name} | ${v.prompt.length} 字符 | ${Date.now() - t0}ms | ${String((e as Error)?.message ?? e).slice(0, 80)}`)
  } finally {
    clearTimeout(killer)
    try {
      session.dispose?.()
    } catch {
      /* 忽略 */
    }
  }
}

async function main() {
  for (const v of variants) {
    await runOne(v)
  }
  process.exit(0)
}

void main()
