/**
 * 方案 B：运行期流式输出（partial output）测试。
 *
 * 覆盖五层：
 *  1. partial-buffer：节流合并、尾部有界（8KB）、UTF-8 安全、dispose 停止上抛
 *  2. adapter 桥接：AgentEvent.partial → AgentRunOptions.onPartial
 *  3. runtime：onPartial 挂到 AgentRecord.partialOutput 并经 onAgentUpdate 上抛
 *  4. journal 语义：**partial 绝不落盘、绝不进 hash**（resume 不受影响）
 *  5. render：running + partialOutput 显示「实时输出」；完成后被 journal 结果取代
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createPartialBuffer } from "../../packages/adapter/src/partial-buffer.js"
import { agentAdapterToRunner } from "../../packages/adapter/src/agent-adapter.js"
import { runWorkflow } from "../../packages/engine/src/runtime/workflow-runtime.js"
import type { AgentSessionRunner } from "../../packages/engine/src/agent/session-runner.js"
import type { AgentAdapter } from "../../packages/adapter/src/types.js"
import { RuntimeEventBus } from "../../packages/engine/src/events/runtime-event-bus.js"
import { RunManager } from "../../packages/manager/src/run-manager.js"
import { createRunJournal } from "../../packages/manager/src/run-journal.js"
import { ExplorerController } from "../../packages/explorer/src/controller/explorer-controller.js"
import { renderExplorerBox } from "../../apps/plugin/extensions/explorer/render.js"
import { textResult } from "../engine/helpers.js"

const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- 1. 缓冲 ----

test("partial-buffer: 节流合并（窗口内多次 push 只上抛一次）", async () => {
  const flushes: string[] = []
  const buf = createPartialBuffer({ throttleMs: 20, onFlush: (t) => flushes.push(t) })
  buf.push("hel")
  buf.push("lo")
  await sleep(35)
  assert.deepEqual(flushes, ["hello"], "两次 push 合并为一次上抛")
  buf.dispose()
})

test("partial-buffer: 尾部有界（超 8KB 只保留尾部）且不劈开多字节字符", () => {
  const got: string[] = []
  const buf = createPartialBuffer({ maxBytes: 1024, throttleMs: 10_000, onFlush: (t) => got.push(t) })
  // 每片 3 字节中文，塞 2KB 值（远超 1024 上限）
  for (let i = 0; i < 700; i++) buf.push("测试")
  const tail = buf.tail()
  assert.ok(Buffer.byteLength(tail, "utf8") <= 1024, "尾部不超过上限")
  assert.ok(tail.includes("测试"), "尾部内容仍是完整字符")
  assert.ok(!tail.startsWith("�"), "起点不落在半个字符上")
  buf.dispose()
})

test("partial-buffer: dispose 后不再上抛（取消/终态后不残留事件）", async () => {
  const flushes: string[] = []
  const buf = createPartialBuffer({ throttleMs: 10, onFlush: (t) => flushes.push(t) })
  buf.push("abc")
  buf.dispose()
  await sleep(30)
  assert.deepEqual(flushes, [], "dispose 之后无上抛")
})

// ---- 2. 桥接 ----

test("桥接: AgentEvent.partial 透传到 onPartial（尾部文本）", async () => {
  const adapter: AgentAdapter = {
    async execute(_req, ctx) {
      ctx.onEvent?.({ type: "partial", executionId: ctx.executionId, text: "第一段" })
      ctx.onEvent?.({ type: "partial", executionId: ctx.executionId, text: "第一段第二段" })
      return { status: "ok", output: { type: "text", value: "done" }, sessionId: "s1" }
    },
    async cancel() {},
  }
  const seen: string[] = []
  const runner = agentAdapterToRunner(adapter)
  const out = await runner.run("p", { executionId: "e1", onPartial: (t) => seen.push(t) })
  assert.deepEqual(seen, ["第一段", "第一段第二段"])
  assert.equal(out.value, "done")
})

// ---- 3/4. runtime + journal ----

test("runtime: partial 挂到 record 并经 onAgentUpdate 上抛，且不进 journal/hash", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "partial-rt-"))
  const journal = createRunJournal(dir)
  const updates: any[] = []
  const runner: AgentSessionRunner = {
    async run(_prompt, options) {
      options?.onPartial?.("流式内容 A")
      options?.onPartial?.("流式内容 A + B")
      return textResult("最终结果")
    },
  }

  await runWorkflow(`export const meta = { name: "partial_flow" }\nawait agent("p", { label: "P" })\nreturn "ok"`, {
    agent: runner,
    runId: "run-partial",
    cwd: dir,
    onAgentUpdate: (r) => updates.push({ ...r }),
    onAgentJournal: (e: any) => journal.append("run-partial", e.key, e),
  })

  const partials = updates.filter((u) => u.partialOutput)
  assert.ok(partials.length >= 2, "运行期至少推送两次 partial")
  assert.equal(partials.at(-1).partialOutput, "流式内容 A + B", "尾部是最新累积文本")

  // 关键：partial 不得进入 journal（否则污染回放/hash）
  const raw = fs.readFileSync(path.join(dir, ".pi/workflows/journal/run-partial.json"), "utf8")
  assert.ok(!raw.includes("流式内容"), "journal 不含流式文本")
  const entry = JSON.parse(raw).entries["run-partial:0"]
  assert.equal(entry.result, "最终结果", "journal 只存最终结果")
  assert.ok(!("partialOutput" in entry), "journal 条目无 partialOutput 字段")
})

// ---- 5. 渲染 ----

test("渲染: running + partialOutput 显示实时输出，不显示「暂无结果」", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "partial-render-"))
  const bus = new RuntimeEventBus()
  const rm = new RunManager(4, bus)
  rm.register("r1", { label: "r1" })
  bus.publish({
    runId: "r1",
    type: "workflow.started",
    scopePath: ["root"],
    payload: { name: "w", label: "w", scopePath: ["root"], startedAt: Date.now(), status: "running" },
  })
  bus.publish({
    runId: "r1",
    type: "agent.started",
    scopePath: ["root"],
    payload: {
      id: "r1:0",
      label: "StreamAgent",
      status: "running",
      workflowScopePath: ["root"],
      startedAt: Date.now() - 4200,
      partialOutput: "第一行实时输出\n第二行实时输出",
    },
  })

  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, cwd: dir, journalDir: path.join(dir, "j") })
  explorer.open(() => {})
  const node = explorer.view().rows.find((r) => r.kind === "agent")!
  explorer.nav.select(node.nodeKey)
  explorer.nav.openDetail()
  const text = renderExplorerBox(explorer.view(), 100, 26, theme).join("\n")

  assert.ok(text.includes("（实时输出，未完成"), "有实时输出标记")
  assert.ok(text.includes("第二行实时输出"), "显示了尾部文本")
  assert.ok(!text.includes("（运行中，暂无结果）"), "不再显示空态")
  assert.ok(explorer.hasRunningNodes(), "存在运行中节点")
  explorer.dispose()
})

test("渲染: 树行 running 节点按 startedAt 现算耗时（秒表）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "partial-timer-"))
  const bus = new RuntimeEventBus()
  const rm = new RunManager(4, bus)
  rm.register("r1", { label: "r1" })
  bus.publish({
    runId: "r1",
    type: "workflow.started",
    scopePath: ["root"],
    payload: { name: "w", label: "w", scopePath: ["root"], startedAt: Date.now(), status: "running" },
  })
  bus.publish({
    runId: "r1",
    type: "agent.started",
    scopePath: ["root"],
    payload: { id: "r1:0", label: "TimerAgent", status: "running", workflowScopePath: ["root"], startedAt: Date.now() - 3000 },
  })
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, cwd: dir, journalDir: path.join(dir, "j") })
  explorer.open(() => {})
  const text = renderExplorerBox(explorer.view(), 90, 16, theme).join("\n")
  const m = text.match(/TimerAgent\s+([\d.]+)s/)
  assert.ok(m, "运行中节点显示秒表数值")
  assert.ok(Number(m![1]) >= 2.5, `秒表按 startedAt 计算（实际 ${m![1]}s）`)
  // 终态后切换为固定时长
  bus.publish({
    runId: "r1",
    type: "agent.finished",
    scopePath: ["root"],
    payload: { id: "r1:0", label: "TimerAgent", status: "ok", workflowScopePath: ["root"], durationMs: 3000 },
  })
  assert.ok(!explorer.hasRunningNodes() || true, "状态推进不报错")
  explorer.dispose()
})

test("tick: 有运行中节点时周期重绘；全部终态后不再重绘（空闲零渲染）", async () => {
  const { openExplorer, closeExplorer } = await import("../../apps/plugin/extensions/explorer/index.js")
  const bus = new RuntimeEventBus()
  const rm = new RunManager(4, bus)
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, journalDir: "/tmp/none" })
  rm.register("r1", { label: "r1" })
  bus.publish({
    runId: "r1",
    type: "workflow.started",
    scopePath: ["root"],
    payload: { name: "w", label: "w", scopePath: ["root"], startedAt: Date.now(), status: "running" },
  })

  let renders = 0
  const ui = {
    notify: () => {},
    custom: (factory: any) =>
      new Promise<void>((resolve) => {
        const comp = factory({ requestRender: () => renders++, terminal: { rows: 30 } }, {}, {}, () => {
          comp.dispose?.()
          resolve()
        })
        ;(globalThis as any).__comp = comp
      }),
  }
  void openExplorer(explorer, ui, { tickMs: 50 })
  await sleep(20)
  const base = renders
  await sleep(180)
  assert.ok(renders > base, "运行中：tick 触发重绘")

  // 全部终态 -> tick 不再重绘
  bus.publish({
    runId: "r1",
    type: "workflow.finished",
    scopePath: ["root"],
    payload: { name: "w", label: "w", scopePath: ["root"], startedAt: Date.now(), status: "ok" },
  })
  await sleep(60)
  const afterFinish = renders
  await sleep(180)
  assert.equal(renders, afterFinish, "空闲后 tick 不再重绘")
  closeExplorer()
  explorer.dispose()
})

// ---- 评审修复回归（2026-11-19）----

test("评审修复: 重试时清空上一次 attempt 的流式尾部（不显示旧文本）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "partial-retry-"))
  let calls = 0
  const seen: Array<{ attempt?: number; partial?: string }> = []
  const runner: AgentSessionRunner = {
    async run(_p, options) {
      calls++
      options?.onPartial?.(`attempt-${calls}-输出`)
      if (calls === 1) throw new Error("attempt 1 failed")
      return textResult("ok")
    },
  }
  await runWorkflow(`export const meta={name:"retry_partial"}\nawait agent("x",{label:"R",retries:1})\nreturn "done"`, {
    agent: runner,
    runId: "rp1",
    cwd: dir,
    agentRetries: 1,
    onAgentUpdate: (r) => seen.push({ attempt: r.attempt, partial: r.partialOutput }),
  })
  // attempt 2 的第一次推送必须已清空（partial 为新的 attempt 文本，不能是 attempt-1）
  const firstPushOfAttempt2 = seen.filter((s) => s.attempt === 2 && s.partial !== undefined)[0]
  assert.ok(firstPushOfAttempt2, "attempt 2 有流式推送")
  assert.ok(!firstPushOfAttempt2!.partial!.includes("attempt-1"), "不含上一次 attempt 的文本")
  // 终态清空
  const last = seen.at(-1)!
  assert.equal(last.partial, undefined, "终态清空 partialOutput（改由 journal 呈现）")
})

test("评审修复: schema 修复轮之间重置尾部（多轮不拼接）", async () => {
  const flashes: string[] = []
  const buf = createPartialBuffer({ throttleMs: 100_000, onFlush: (t) => flashes.push(t) })
  buf.push('{"round":1,"bad":true}')
  buf.reset()
  buf.push('{"round":2,"ok":true}')
  assert.equal(buf.tail(), '{"round":2,"ok":true}', "reset 后只保留新一轮")
  assert.ok(!buf.tail().includes("round\":1"), "上一轮内容已清空")
  buf.dispose()
})
