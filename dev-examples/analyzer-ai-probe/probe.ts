/**
 * AI 调用超时探针：分阶段打点定位 createPlannerAgent 60s 超时的真实原因
 *
 * 用法：npx tsx dev-examples/analyzer-ai-probe/probe.ts [promptSize]
 * 产出：各阶段耗时 + session 实际使用的 model
 */
import { DefaultResourceLoader, SettingsManager, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent"
import os from "node:os"
import path from "node:path"

const T0 = Date.now()
const el = (label: string) => console.log(`[${String(Date.now() - T0).padStart(6)}ms] ${label}`)
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent")
const CWD = process.cwd()

async function main() {
  el("start")

  // 阶段 1：SettingsManager —— 能否读到 provider/model/credential
  const sm = SettingsManager.create(CWD, AGENT_DIR)
  el("SettingsManager.create")
  const s = sm as unknown as Record<string, unknown>
  const getter = (k: string) => (typeof s[k] === "function" ? (s[k] as () => unknown)() : s[k])
  console.log("   defaultProvider =", getter("getDefaultProvider") ?? getter("defaultProvider"))
  console.log("   defaultModel    =", getter("getDefaultModel") ?? getter("defaultModel"))

  // 阶段 2：ResourceLoader（noExtensions=true，与 adapter 一致）
  const loader = new DefaultResourceLoader({ cwd: CWD, agentDir: AGENT_DIR, noExtensions: true })
  await loader.reload()
  el("loader.reload (noExtensions=true)")

  // 阶段 3：createAgentSession
  const created = await createAgentSession({
    cwd: CWD,
    agentDir: AGENT_DIR,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.create(CWD, AGENT_DIR),
    resourceLoader: loader,
  })
  el("createAgentSession")
  const session = created.session as unknown as Record<string, unknown> & {
    prompt: (t: string) => Promise<unknown>
    abort: () => Promise<void>
    dispose?: () => void
  }
  console.log("   sessionId =", session.sessionId, " model =", JSON.stringify(session.model ?? "(unset)").slice(0, 200))

  // 阶段 4：真正发一次 prompt —— 这是超时最容易发生的地方
  const arg = process.argv[2] ?? "0"
  const prompt = arg.endsWith(".txt")
    ? (await import("node:fs")).readFileSync(arg, "utf8")
    : Number(arg) > 0
      ? `只回复 ok。以下为填充文本，忽略即可：\n${"x".repeat(Number(arg))}`
      : "只回复 ok"
  console.log(`   prompt 长度 = ${prompt.length}`)

  // 事件订阅：看清模型在思考 / 输出 / 还是无响应
  const t1 = Date.now()
  const HEARTBEAT = 10_000
  let firstEvent = 0
  let textChunks = 0
  let totalChars = 0
  const rawSub = (session as unknown as { subscribe?: (cb: (e: unknown) => void) => () => void }).subscribe
  if (typeof rawSub === "function") {
    rawSub.call(session, (e: unknown) => {
      const ev = e as Record<string, any>
      if (!firstEvent) {
        firstEvent = Date.now() - t1
        console.log(`   [event] 首个事件 @${firstEvent}ms type=${ev.type}`)
      }
      if (ev.type === "message_delta" || ev.type === "content_block_delta") {
        textChunks++
        totalChars += String(ev.delta?.text ?? ev.delta ?? "").length
      }
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        for (const c of ev.message.content ?? []) if (c.type === "text") totalChars += c.text.length
        console.log(`   [event] assistant message_end @${Date.now() - t1}ms chars=${totalChars}`)
      }
      if (ev.type === "thinking" || ev.type === "reasoning") {
        console.log(`   [event] thinking @${Date.now() - t1}ms`)
      }
    })
  } else {
    console.log("   (session 无 subscribe)")
  }

  let tick = 0
  const hb = setInterval(() => {
    tick++
    console.log(`   ...等待中 ${tick}/${HEARTBEAT / 1000}0ms (已 ${Date.now() - t1}ms)`)
  }, HEARTBEAT)

  const killer = setTimeout(() => {
    console.error(`[失败] prompt 超过 120s 未返回，主动 abort`)
    void session.abort()
  }, 120_000)

  try {
    const r = await session.prompt(prompt)
    clearInterval(hb)
    clearTimeout(killer)
    el(`prompt 返回（耗时 ${Date.now() - t1}ms）`)
    console.log("   result =", String(JSON.stringify(r)).slice(0, 300))
  } catch (e) {
    clearInterval(hb)
    clearTimeout(killer)
    console.error(`[失败] prompt 抛错（耗时 ${Date.now() - t1}ms）：`, String((e as Error)?.message ?? e))
  } finally {
    try {
      session.dispose?.()
    } catch {
      /* 忽略清理异常 */
    }
  }
  el("done")
  process.exit(0)
}

void main()
