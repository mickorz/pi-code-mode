/**
 * 结构化（JSON schema）结果展示测试 —— 对齐 REF-001 `result-view.ts` 语义。
 *
 * 覆盖：
 *  - structured 结果 pretty-print（2 空格缩进，不是 String(obj)）
 *  - 渲染期脱敏（api_key/secret/token... → [REDACTED]），journal 原值不动
 *  - 20KB 上限 + truncated 标记与原始体积
 *  - 空态三分：error / pending / empty
 *  - preview 兜底（journal 无 result 时用节点快照预览）
 *  - outputType 缺省时按值类型推断（老 journal）
 *  - 端到端：schema agent → journal → Explorer 详情渲染（含脱敏断言）
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { formatResultBody, resolveResultState, RESULT_MAX_BYTES } from "../../packages/explorer/src/repository/result-view.js"
import { renderExplorerBox } from "../../apps/plugin/extensions/explorer/render.js"
import { RuntimeEventBus } from "../../packages/engine/src/events/runtime-event-bus.js"
import { RunManager } from "../../packages/manager/src/run-manager.js"
import { createRunJournal } from "../../packages/manager/src/run-journal.js"
import { runWorkflow } from "../../packages/engine/src/runtime/workflow-runtime.js"
import { ExplorerController } from "../../packages/explorer/src/controller/explorer-controller.js"
import type { AgentSessionRunner } from "../../packages/engine/src/agent/session-runner.js"
import { structuredResult } from "../engine/helpers.js"

const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s }

test("structured: pretty-print 2 空格缩进（不是 String(obj)）", () => {
  const view = formatResultBody({ ok: true, items: [1, 2] }, "structured")
  assert.equal(view.kind, "structured")
  assert.equal(view.body, JSON.stringify({ ok: true, items: [1, 2] }, null, 2))
  assert.ok(view.body.includes("\n  \"ok\": true"))
  assert.equal(view.truncated, false)
})

test("structured: text 路径原样输出（不 JSON 转义）", () => {
  const view = formatResultBody("completed\nsecond line", "text")
  assert.equal(view.kind, "text")
  assert.equal(view.body, "completed\nsecond line")
})

test("脱敏: 敏感键在渲染副本中被打码，其余字段保留", () => {
  const view = formatResultBody(
    { ok: true, api_key: "sk-live-xxx", nested: { secret: "s", token: "t", keep: 1 }, list: [{ password: "p" }] },
    "structured",
  )
  assert.ok(!view.body.includes("sk-live-xxx"), "原值不出现在渲染正文")
  assert.equal((view.body.match(/\[REDACTED\]/g) ?? []).length, 4, "4 个敏感键被打码")
  assert.ok(view.body.includes('"ok": true'))
  assert.ok(view.body.includes('"keep": 1'))
})

test("截断: 超 20KB 截断并标记原始体积", () => {
  // text 路径最直接（structured 的数组会被 redactValue 按 50 项封顶，与 REF-001 同语义）
  const big = "x".repeat(RESULT_MAX_BYTES + 5000)
  const view = formatResultBody(big, "text")
  assert.equal(view.truncated, true)
  assert.ok(Buffer.byteLength(view.body, "utf8") <= RESULT_MAX_BYTES)
  assert.ok(view.originalBytes > RESULT_MAX_BYTES)
})

test("structured: 数组按 50 项封顶（与 REF-001 redactValue 同语义，防止超大数组灌满详情）", () => {
  const view = formatResultBody({ rows: Array.from({ length: 200 }, (_, i) => i) }, "structured")
  assert.equal(view.truncated, false, "封顶发生在脱敏阶段而非截断阶段")
  const parsed = JSON.parse(view.body)
  assert.equal(parsed.rows.length, 50)
})

test("空态三分: failed→error, running→pending, 终态无结果→empty", () => {
  assert.deepEqual(resolveResultState({ status: "failed", error: "boom" }), { state: "error", message: "boom" })
  assert.deepEqual(resolveResultState({ status: "failed" }), { state: "error", message: "Agent failed" })
  assert.deepEqual(resolveResultState({ status: "running" }), { state: "pending" })
  assert.deepEqual(resolveResultState({ status: "ok" }), { state: "empty" })
  assert.deepEqual(resolveResultState({ status: "aborted" }), { state: "empty" })
})

test("preview 兜底: journal 无 result 时用快照预览", () => {
  const state = resolveResultState({ status: "ok", outputPreview: "截断预览内容" })
  assert.equal(state.state, "content")
  if (state.state === "content") {
    assert.equal(state.source, "preview")
    assert.ok(state.view.body.includes("截断预览内容"))
  }
})

test("outputType 缺省时按值类型推断（老 journal 兼容）", () => {
  const asString = resolveResultState({ status: "ok", result: "纯文本" })
  assert.equal(asString.state, "content")
  if (asString.state === "content") assert.equal(asString.view.kind, "text")

  const asObject = resolveResultState({ status: "ok", result: { a: 1 } })
  assert.equal(asObject.state, "content")
  if (asObject.state === "content") assert.equal(asObject.view.kind, "structured")
})

test("E2E: schema agent 结果在 Explorer 详情里 pretty-print 且脱敏", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-e2e-"))
  const bus = new RuntimeEventBus()
  const rm = new RunManager(4, bus)
  const journal = createRunJournal(dir)
  const runner: AgentSessionRunner = {
    async run() {
      return structuredResult({ ok: true, summary: "插件可用", plugins: ["a"], api_key: "sk-live-xxx" })
    },
  }
  rm.register("run-schema", { label: "schema" })
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, cwd: dir, journal })
  explorer.open(() => {})

  await runWorkflow(
    `export const meta = { name: "schema_flow" }
const r = await agent("返回 JSON", { label: "SchemaAgent", schema: { type: "object" } })
return r`,
    {
      agent: runner,
      runId: "run-schema",
      cwd: dir,
      onAgentJournal: (e: any) => journal.append("run-schema", e.key, e),
      onRuntimeEvent: (e: any) => bus.publish(e),
    },
  )

  const agentNode = explorer.view().rows.find((r) => r.kind === "agent")!
  assert.equal(agentNode.metadata?.outputType, "structured", "节点带 structured 标记")

  // journal 保留原值（resume 语义），脱敏只发生在渲染副本
  const detail = explorer.detailFor(agentNode.nodeKey)!
  assert.equal((detail.agent?.result as any)?.api_key, "sk-live-xxx", "journal 原值不被改写")

  explorer.nav.select(agentNode.nodeKey)
  explorer.nav.openDetail()
  const text = renderExplorerBox(explorer.view(), 100, 26, theme).join("\n")
  assert.ok(text.includes('"ok": true'), "JSON 字段可见")
  assert.ok(text.includes("[REDACTED]"), "敏感键已打码")
  assert.ok(!text.includes("sk-live-xxx"), "原值不泄露")
  assert.ok(text.includes("输出 structured"), "详情头部标注输出类型")
  explorer.dispose()
})

// ---- 真实运行数据回归（2026-11-19 现场验收 journal）----
// run-1795066380553-qcs7cy：SchemaAgent(structured 230B) + BigTextAgent(text 12.8KB)
//                            + runTool(probe-fail.js, 只有 executions 无 result)
test("真实数据: 工具失败节点状态是 error（不是 failed），必须显示错误原因", () => {
  const state = resolveResultState({
    status: "error",
    error: 'exit 1: ',
  })
  assert.equal(state.state, "error", "tool 的 status=error 也要走 error 分支")
  if (state.state === "error") assert.match(state.message, /exit 1/)

  // 对照：仅 executions、无 result 的成功工具仍应是 empty 而不是 error
  assert.deepEqual(resolveResultState({ status: "ok" }), { state: "empty" })
})

test("真实数据: 工具节点详情不显示「无结果返回」而是错误（端到端渲染）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-err-"))
  const bus = new RuntimeEventBus()
  const rm = new RunManager(4, bus)
  const journal = createRunJournal(dir)
  rm.register("run-toolerr", { label: "toolerr" })
  // 事件形状对齐 runtime 的 tool.finished（status=error + error 文案）
  bus.publish({
    runId: "run-toolerr",
    type: "workflow.started",
    scopePath: ["root"],
    payload: { name: "t", label: "t", scopePath: ["root"], startedAt: 1, status: "running" },
  })
  bus.publish({
    runId: "run-toolerr",
    type: "tool.finished",
    scopePath: ["root"],
    payload: {
      toolId: "run-toolerr:0",
      name: "probe-fail.js",
      kind: "runtime",
      scopePath: ["root"],
      status: "error",
      startedAt: 1,
      endedAt: 30,
      durationMs: 23,
      error: "exit 1: ",
    },
  })
  journal.recordExecution("run-toolerr", "run-toolerr:0", {
    executionId: "run-toolerr:0:t1",
    attempt: 1,
    status: "failed",
    label: "tool probe-fail.js",
    error: "exit 1: ",
    startedAt: 1,
    durationMs: 23,
  })

  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, cwd: dir, journal })
  explorer.open(() => {})
  const toolNode = explorer.view().rows.find((r) => r.kind === "tool")!
  explorer.nav.select(toolNode.nodeKey)
  explorer.nav.openDetail()
  const text = renderExplorerBox(explorer.view(), 100, 24, theme).join("\n")
  assert.ok(text.includes("错误:"), "显示错误区块")
  assert.ok(text.includes("exit 1"), "错误原因可见")
  assert.ok(!text.includes("（无结果返回）"), "不应显示空态文案")
  assert.ok(text.includes("#1 [FAIL]"), "attempts 历史仍可见")
  explorer.dispose()
})
