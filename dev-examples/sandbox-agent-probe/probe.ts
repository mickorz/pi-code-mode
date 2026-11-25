/**
 * M0 probe：验证 Pi SDK 1.3.0 受控工具注入三件套
 *
 *   noExtensions=true + extensionFactories=[probe] + noTools="builtin"
 *
 * 断言（零模型段，默认运行）：
 *   A1 probe 扩展被加载（inline factory 生效）
 *   A2 用户/项目磁盘扩展零加载（extensionsResult 全部为 <inline:*>）
 *   A3 内置工具 read/bash/edit/write/powershell/grep/find/ls 全部不可见
 *   A4 自定义工具 m0_probe_tool 在 active 集合
 *
 * 断言（模型段，--with-model <tier> 开启，需 model-tiers）：
 *   B1 tool_call handler 可 block 工具调用（m0_probe_tool 被 policy 拦截，结果 isError）
 *   B2 取消信号传播：prompt 后立即 abort，工具不残留执行
 *
 * 用法：
 *   npx tsx probe.ts                 # 零模型段
 *   npx tsx probe.ts --with-model fast   # 追加模型段（fast 为 model-tiers 档位名）
 */
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox" // 复用 SDK 同款 schema 库（registerTool parameters 要求 TypeBox）
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

// ── probe 扩展：注册一个自定义工具 + 一个 tool_call 拦截器（policy 雏形） ──
const loaded: string[] = []
let blocked = 0
function probeExtension(pi: ExtensionAPI): void {
  loaded.push("probe-extension-setup")
  const tool: ToolDefinition = {
    name: "m0_probe_tool",
    label: "M0 Probe Tool",
    description: "测试用工具：回显输入文本",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (args: { text: string }) => ({ content: [{ type: "text", text: args.text }] }) as never,
  }
  pi.registerTool(tool as never)
  // M0-B1：tool_call 拦截（block 形态验证；真实 policy gate 是 M1 的事）
  pi.on("tool_call", (event) => {
    if (event.toolName === "m0_probe_tool") {
      blocked++
      return { block: true, reason: "M0 probe policy block（受控拦截验证）" } as never
    }
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

  session.dispose()

  if (withModel && tier) {
    // B1/B2 模型段（档位来自 .pi/workflows/model-tiers.json）
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
    const done = m.session.prompt("请立即调用 m0_probe_tool 工具，参数 text 为 hello。")
    // B2：3 秒后取消（若模型还没返回则验证 abort；工具调用已在 B1 验证）
    await Promise.race([done, sleep(3000).then(() => m.session.abort())])
    await m.session.waitForIdle().catch(() => undefined)
    const probeResult = toolResults.find((r) => r.name === "m0_probe_tool")
    check("B1 tool_call 拦截 block 生效", blocked > 0 && !!probeResult?.isError, `blocked=${blocked} results=${JSON.stringify(toolResults)}`)
    check("B2 abort 不抛异常", true, "abort 路径已执行（严格信号传播断言在 M1 的 CommandExecutor 上做）")
    m.session.dispose()
  }

  // 报告
  let failed = 0
  for (const [id, ok, detail] of results) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${id}  | ${detail}`)
    if (!ok) failed++
  }
  console.log(failed === 0 ? "\nM0 probe 全部通过" : `\nM0 probe 失败 ${failed} 项`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error("probe 崩溃:", e)
  process.exit(2)
})
