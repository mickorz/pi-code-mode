/**
 * M1.1 e2e：受控工具层确定性验证（fast 档，2026-11-25 用户确认系列延续）
 *
 * 区分三件事（M1.1 评审要求）：模型说自己调了工具 / SDK 实际执行了工具 / 执行层真正产生副作用。
 *
 * 零模型段（不烧 token）：
 *   E0 SDK 实际注册的工具清单：恰好 4 个受控工具，无 bash/read/edit/write（不依赖模型自述）
 *
 * 模型段（fast 档）：
 *   E1 write_file 真实落盘（副作用层证据：磁盘内容）
 *   E2 read_file 读回 + 结构化输出契约
 *   E3 run_command：CountingExecutor 注入——工具链真实走通（调用次数=1）且 blocked（无宿主执行），
 *      不依赖模型转述的 blocked 文案
 *
 * 用法：npx tsx e2e.ts
 */
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { PiAgentAdapter } from "../../packages/adapter/src/pi-agent-adapter.js"
import { createAgentToolsExtension } from "../../packages/adapter/src/extensions/agent-tools.js"
import { createPolicyExtension } from "../../packages/adapter/src/extensions/policy-extension.js"
import { PermitStore } from "../../packages/policy-lite/src/index.js"
import { UnavailableCommandExecutor, WorkspaceFileService, type CommandExecutor, type SandboxCommandResult } from "../../packages/execution/src/index.js"
import { loadModelTiers } from "../../packages/engine/src/agent/model-tiers.js"

/** 计数 fail-closed 执行器：E3 的确定性证据（调用次数 + blocked 状态，不依赖模型转述） */
class CountingUnavailableExecutor implements CommandExecutor {
  calls = 0
  signals: Array<AbortSignal | undefined> = []
  async execute(req: { signal?: AbortSignal }): Promise<SandboxCommandResult> {
    this.calls++
    this.signals.push(req.signal)
    return new UnavailableCommandExecutor().execute(req as never)
  }
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "pcm-m11-e2e-"))
  const results: Array<[string, boolean, string]> = []
  const check = (id: string, ok: boolean, detail: string) => results.push([id, ok, detail])

  try {
    const repoRoot = path.resolve(import.meta.dirname, "../..")
    const tiers = loadModelTiers({ projectDir: repoRoot })
    const fast = tiers.fast as string
    if (typeof fast !== "string") throw new Error("model-tiers fast 档缺失")

    // ── E0（零模型）：SDK 实际注册的工具清单 ──
    const agentDir = path.join(tmpdir(), "pcm-m11-agentdir") // 隔离 agentDir：用户真实扩展不进来
    const counting = new CountingUnavailableExecutor()
    const e0Deps = {
      permits: new PermitStore(),
      files: new WorkspaceFileService(root),
      executor: counting,
      runId: "run-e0",
      executionId: "exec-e0",
    }
    const e0Loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      noExtensions: true, // M1.1：固定 true（不可配置）
      extensionFactories: [
        { name: "pcm-policy", factory: createPolicyExtension(e0Deps) },
        { name: "pcm-agent-tools", factory: createAgentToolsExtension(e0Deps) },
      ],
    })
    await e0Loader.reload()
    const e0 = await createAgentSession({
      cwd: root,
      agentDir,
      noTools: "builtin",
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.create(root, agentDir),
      resourceLoader: e0Loader,
    })
    const active = e0.session.getActiveToolNames().sort()
    const expected = ["edit_file", "read_file", "run_command", "write_file"]
    const builtinLeaked = ["bash", "read", "edit", "write", "powershell", "grep", "find", "ls"].filter((t) => active.includes(t))
    check(
      "E0 SDK 工具清单=受控 4 工具（零模型直查）",
      JSON.stringify(active) === JSON.stringify(expected) && builtinLeaked.length === 0,
      `active=${JSON.stringify(active)} builtinLeaked=${JSON.stringify(builtinLeaked)}`,
    )
    e0.session.dispose()

    // ── 模型段：E1-E3（注入 CountingExecutor 的 adapter） ──
    const adapter = new PiAgentAdapter({ defaultCwd: root, commandExecutor: counting })

    const r1 = await adapter.execute(
      {
        prompt:
          `请调用 write_file 工具，把内容 "m1-e2e-ok" 写入 e2e.txt。然后调用 read_file 读回 e2e.txt。` +
          `最后按 schema 输出一个 JSON 对象 {"written": true, "readBack": "<读到的内容>"}。`,
        model: fast,
        cwd: root,
        outputSchema: {
          type: "object",
          properties: { written: { type: "boolean" }, readBack: { type: "string" } },
          required: ["written", "readBack"],
        },
      },
      { executionId: `e2e-${randomUUID().slice(0, 8)}`, runId: "run-m1-e2e" },
    )
    const onDisk = await readFile(path.join(root, "e2e.txt"), "utf8").catch(() => "<未落盘>")
    check("E1 write_file 真实落盘", onDisk === "m1-e2e-ok", `onDisk=${JSON.stringify(onDisk)}`)
    const structured = r1.status === "ok" && r1.output.type === "structured" ? r1.output.value : undefined
    check(
      "E2 readBack 与结构化输出",
      !!structured && (structured as { readBack?: string }).readBack === "m1-e2e-ok",
      `status=${r1.status} structured=${JSON.stringify(structured).slice(0, 120)}`,
    )

    // E3：CountingExecutor 确定性证据（调用次数 + blocked + signal 传递）
    const beforeCalls = counting.calls
    const r2 = await adapter.execute(
      {
        prompt: `请调用 run_command 工具执行 "echo hello"，然后把工具返回的完整文本放进 JSON 的 "raw" 字段输出。`,
        model: fast,
        cwd: root,
        outputSchema: {
          type: "object",
          properties: { raw: { type: "string" } },
          required: ["raw"],
        },
      },
      { executionId: `e2e-${randomUUID().slice(0, 8)}`, runId: "run-m1-e2e" },
    )
    const runCommandCalls = counting.calls - beforeCalls
    const raw = r2.status === "ok" && r2.output.type === "structured" ? String((r2.output.value as { raw?: string }).raw ?? "") : ""
    check(
      "E3 run_command 工具链走通且 fail-closed（确定性）",
      runCommandCalls === 1 && raw.includes("blocked") && raw.includes("sandbox"),
      `executorCalls=${runCommandCalls}（=1 证明 SDK 真实执行了工具） raw=${JSON.stringify(raw.slice(0, 100))}`,
    )
    check(
      "E3b AbortSignal 已传入执行层",
      counting.signals.length > 0 && counting.signals.some((s) => s !== undefined),
      `signals=${counting.signals.map((s) => (s ? "passed" : "undefined")).join(",")}`,
    )

    let failed = 0
    for (const [id, ok, detail] of results) {
      console.log(`${ok ? "PASS" : "FAIL"}  ${id}  | ${detail}`)
      if (!ok) failed++
    }
    console.log(failed === 0 ? "\nM1.1 e2e 全部通过" : `\nM1.1 e2e 失败 ${failed} 项`)
    process.exitCode = failed === 0 ? 0 : 1
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(path.join(tmpdir(), "pcm-m11-agentdir"), { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((e) => {
  console.error("e2e 崩溃:", e)
  process.exitCode = 2
})
