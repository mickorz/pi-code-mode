/**
 * M0/M0.1 probe：验证 Pi SDK 1.3.0 受控工具注入 + 双阶段 Permit 防线
 *
 *   noExtensions=true + extensionFactories=[probe] + noTools="builtin"
 *
 * 零模型段（默认运行）：
 *   A1 probe 扩展被加载（inline factory 生效）
 *   A2 用户/项目磁盘扩展零加载（extensionsResult 全部为 <inline:*>）
 *   A3 内置工具 read/bash/edit/write/powershell/grep/find/ls 全部不可见
 *   A4 自定义工具在 active 集合
 *   C4 Permit 一次性消费（第二次 consume 拒绝）
 *   C5 过期 Permit 拒绝
 *
 * 模型段（--with-model <tier>，需 model-tiers；fast 档 2026-11-25 用户确认，M0.1 沿用）：
 *   B1 tool_call handler 正确 block 形态 -> 工具结果 isError=true
 *   C1 block 后工具实际执行计数 = 0
 *   C2 handler 返回错误形态时：SDK 静默放行（execute 被进入），但 Permit 第二层拦截，
 *      实际执行计数 = 0 —— 证明"事件回调不能是唯一防线"（M0.1 核心结论）
 *   C3 allow 路径：Permit 正常签发与消费，工具执行计数 = 1
 *
 * 用法：
 *   npx tsx probe.ts                     # 零模型段
 *   npx tsx probe.ts --with-model fast   # 追加模型段（fast 为 model-tiers 档位名）
 */
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI, type ToolCallEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { Type } from "typebox"
import { setTimeout as sleep } from "node:timers/promises"

// ── M0.1 冻结契约：ToolPermit（正式版进 packages/policy-lite，此处为行为验证桩） ──
interface ToolPermit {
  toolCallId: string
  toolName: string
  paramsDigest: string
  issuedAt: number
  expiresAt: number
}
const PERMIT_TTL_MS = 60_000

/** Permit Store 按 AgentSession 隔离（probe 单会话，单 Map 即可；禁止全局共享是 M1 硬规则） */
class PermitStore {
  private readonly permits = new Map<string, ToolPermit>()
  issue(toolCallId: string, toolName: string, params: unknown): ToolPermit {
    const permit: ToolPermit = {
      toolCallId,
      toolName,
      paramsDigest: digest(params),
      issuedAt: Date.now(),
      expiresAt: Date.now() + PERMIT_TTL_MS,
    }
    this.permits.set(toolCallId, permit)
    return permit
  }
  /** 一次性消费：按 toolCallId 查找 -> 校验工具名/参数摘要/过期 -> 删除 -> 返回是否放行 */
  consume(toolCallId: string, toolName: string, params: unknown): boolean {
    const p = this.permits.get(toolCallId)
    if (!p || p.toolName !== toolName || p.paramsDigest !== digest(params) || p.expiresAt < Date.now())
      return false
    this.permits.delete(toolCallId)
    return true
  }
}
function digest(params: unknown): string {
  return createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 16)
}

// ── 观测计数（M0.1：安全断言只认"实际执行计数"，不认 handler 被调用） ──
const loaded: string[] = []
const entered = new Map<string, number>() // execute 被进入（SDK 层放行）
const executed = new Map<string, number>() // 通过 Permit 校验后的真实执行（副作用层）
const blockedProbe = { count: 0 }
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)

const permits = new PermitStore()

function probeExtension(pi: ExtensionAPI): void {
  loaded.push("probe-extension-setup")

  const mkTool = (name: string): ToolDefinition => ({
    name,
    label: `M0 Probe ${name}`,
    description: `测试工具 ${name}：回显输入文本`,
    parameters: Type.Object({ text: Type.String() }),
    // execute 第一个参数即 toolCallId（SDK 契约）：Permit 关联键
    execute: async (toolCallId: string, params: { text: string }) => {
      bump(entered, name)
      // 第二阶段防线：无有效 Permit 一律拒绝执行（fail-closed）
      if (!permits.consume(toolCallId, name, params)) {
        return { content: [{ type: "text", text: `permit denied: ${name} 未持有有效一次性许可，拒绝执行` }], details: undefined }
      }
      bump(executed, name)
      return { content: [{ type: "text", text: params.text }], details: undefined }
    },
  })

  for (const name of ["m0_probe_tool", "m0_allow_tool", "m0_wrong_shape_tool"]) {
    pi.registerTool(mkTool(name))
  }

  // 第一阶段：tool_call 授权（正确形态：ToolCallEventResult { block?, reason? }，无任何类型强转）
  pi.on("tool_call", (event: ToolCallEvent) => {
    if (event.toolName === "m0_probe_tool") {
      blockedProbe.count++
      return { block: true, reason: "M0 probe policy block（deny 路径验证）" }
    }
    if (event.toolName === "m0_allow_tool") {
      permits.issue(event.toolCallId, event.toolName, event.input) // allow -> 签发一次性 Permit
      return undefined
    }
    if (event.toolName === "m0_wrong_shape_tool") {
      // 敌手模拟：故意返回错误形态（无 block 字段）。SDK 会静默放行（emitToolCall 只认 result.block），
      // 此处不签发 Permit —— C2 验证第二层防线必须拦住这种场景。
      // 这也是全文件唯一允许的 as never：它模拟的是写错代码的一方，正是被测对象。
      return { action: "block" } as never
    }
    return undefined
  })
}

const BUILTIN = ["read", "bash", "edit", "write", "powershell", "grep", "find", "ls"] as const

async function main() {
  const withModel = process.argv.includes("--with-model")
  const tier = withModel ? process.argv[process.argv.indexOf("--with-model") + 1] : undefined

  const cwd = process.cwd()
  const agentDir = path.join(os.homedir(), ".pi", "agent") // 真实 agentDir：若用户有全局扩展，noExtensions 必须拦住它们
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    extensionFactories: [{ name: "m0-probe", factory: probeExtension }],
  })
  await loader.reload()

  const created = await createAgentSession({
    cwd,
    agentDir,
    noTools: "builtin",
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.create(cwd, agentDir),
    resourceLoader: loader,
  })
  const { session, extensionsResult } = created

  const results: Array<[string, boolean, string]> = []
  const check = (id: string, ok: boolean, detail: string) => results.push([id, ok, detail])

  // A1 扩展加载
  check("A1 probe 扩展 setup 运行", loaded.includes("probe-extension-setup"), `loaded=${JSON.stringify(loaded)}`)

  // A2 磁盘扩展零加载：所有已加载扩展的 path 都是 <inline:*>
  const paths = extensionsResult.extensions.map((e) => e.sourceInfo?.path ?? String(e))
  const disk = paths.filter((p) => !p.startsWith("<inline:"))
  check("A2 用户/项目扩展零加载", disk.length === 0, `extensions=${JSON.stringify(paths)} errors=${extensionsResult.errors.length}`)

  // A3/A4 工具面
  const active = session.getActiveToolNames()
  const leaked = BUILTIN.filter((t) => active.includes(t))
  check("A3 内置工具全部禁用", leaked.length === 0, `active=${JSON.stringify(active)}`)
  check("A4 自定义工具在 active", active.includes("m0_probe_tool"), `active=${JSON.stringify(active)}`)

  // C4/C5 Permit 语义（单元级，零模型）
  {
    const store = new PermitStore()
    store.issue("call-1", "t", { a: 1 })
    const first = store.consume("call-1", "t", { a: 1 })
    const second = store.consume("call-1", "t", { a: 1 })
    check("C4 Permit 一次性消费", first && !second, `first=${first} second=${second}`)
    const expiring = new PermitStore()
    const stale = { toolCallId: "z", toolName: "t", paramsDigest: digest({}), issuedAt: 0, expiresAt: 1 }
    ;(expiring as unknown as { permits: Map<string, typeof stale> }).permits.set("z", stale)
    const consumed = expiring.consume("z", "t", {})
    check("C5 过期 Permit 拒绝", !consumed, `consumed=${consumed}`)
  }

  session.dispose()

  if (withModel && tier) {
    // B1/C1/C2/C3 模型段（档位来自 .pi/workflows/model-tiers.json；fast 2026-11-25 用户确认）
    const { loadModelTiers } = await import("../../packages/engine/src/agent/model-tiers.js")
    const { resolveModelSpec } = await import("../../packages/adapter/src/model-spec.js")
    const tiers = loadModelTiers({ projectDir: path.resolve(cwd, "../..") })
    const spec = typeof tiers[tier] === "string" ? tiers[tier] : (tiers[tier] as { model: string }[])[0].model
    const resolved = await resolveModelSpec(spec as string)

    const m = await createAgentSession({
      cwd,
      agentDir,
      noTools: "builtin",
      model: resolved.model,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.create(cwd, agentDir),
      resourceLoader: loader,
    })
    const toolResults: Array<{ name: string; isError: boolean }> = []
    // 工具结果是 role="toolResult" 的顶层消息（不是嵌套在事件里），直接从消息流认领
    m.session.subscribe((ev: { type: string; message?: { role?: string; toolName?: string; isError?: boolean } }) => {
      const msg = ev.message
      if (msg?.role === "toolResult" && msg.toolName)
        toolResults.push({ name: msg.toolName, isError: !!msg.isError })
    })
    const ask = (name: string) => m.session.prompt(`请立即调用 ${name} 工具一次，参数 text 为 hello。不要做别的。`)
    await ask("m0_probe_tool").then(() => m.session.waitForIdle()).catch(() => undefined)
    await ask("m0_allow_tool").then(() => m.session.waitForIdle()).catch(() => undefined)
    await ask("m0_wrong_shape_tool").then(() => m.session.waitForIdle()).catch(() => undefined)

    const probeRes = toolResults.find((r) => r.name === "m0_probe_tool")
    check("B1 正确 block 形态 -> isError=true", blockedProbe.count > 0 && !!probeRes?.isError, `blocked=${blockedProbe.count} probeResult=${JSON.stringify(probeRes)}`)
    check("C1 block 后实际执行计数=0", (executed.get("m0_probe_tool") ?? 0) === 0, `entered=${entered.get("m0_probe_tool") ?? 0} executed=${executed.get("m0_probe_tool") ?? 0}`)
    check("C2 错误形态被 Permit 第二层拦截", (entered.get("m0_wrong_shape_tool") ?? 0) > 0 && (executed.get("m0_wrong_shape_tool") ?? 0) === 0, `entered=${entered.get("m0_wrong_shape_tool") ?? 0} executed=${executed.get("m0_wrong_shape_tool") ?? 0}（entered>0 证明 SDK 确实静默放行，executed=0 证明第二层拦住）`)
    check("C3 allow 路径 Permit 正常消费", (executed.get("m0_allow_tool") ?? 0) >= 1, `executed=${executed.get("m0_allow_tool") ?? 0}`)
    m.session.dispose()
  }

  // 报告
  let failed = 0
  for (const [id, ok, detail] of results) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${id}  | ${detail}`)
    if (!ok) failed++
  }
  console.log(failed === 0 ? "\nM0.1 probe 全部通过" : `\nM0.1 probe 失败 ${failed} 项`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error("probe 崩溃:", e)
  process.exit(2)
})
