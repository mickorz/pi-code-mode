/**
 * M2 契约测试：MCP 透传链路（v5 P0-1 + v4/v5 事件通道）
 * 1) executionId 贯通：AgentRunOptions.executionId → AgentRequest/ExecutionContext（不再自造 UUID）
 * 2) tools 透传：AgentRunOptions.tools → AgentRequest.tools（P0-1 三断点补齐）
 * 3) onToolCall 桥接：Adapter record(mcp-tool-call) 事件 → options.onToolCall 窄回调
 * 4) runtime 双落点：成功 attempt → journal entry.toolCalls；失败 attempt → executions[].toolCalls
 * 5) tools 计入 hash 身份：tools 不同 → hash 不同（resume 指纹正确性）
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { agentAdapterToRunner } from "../../src/adapter/agent-adapter.js"
import type { AgentAdapter, AgentRequest, ExecutionContext, AgentResult } from "../../src/adapter/types.js"
import { runWorkflow } from "../../src/engine/runtime/workflow-runtime.js"
import type { AgentRunOptions, McpToolCallSummary } from "../../src/engine/agent/session-runner.js"
import type { JournalEntry } from "../../src/engine/types/index.js"

function makeRecordingAdapter(results: Array<Partial<AgentResult> & { emitRecord?: (ctx: ExecutionContext) => void }>) {
  const requests: Array<{ request: AgentRequest; ctx: ExecutionContext }> = []
  const adapter: AgentAdapter = {
    async execute(request, ctx) {
      const spec = results[requests.length] ?? {}
      requests.push({ request, ctx })
      spec.emitRecord?.(ctx)
      return {
        status: "ok",
        output: { type: "text", value: `ok-${requests.length}` },
        sessionId: `sess-${requests.length}`,
        ...spec,
      } as AgentResult
    },
    async cancel() {},
  }
  return { adapter, requests }
}

test("executionId 贯通：Runtime 注入值到达 Adapter ctx（不自造 UUID）", async () => {
  const { adapter, requests } = makeRecordingAdapter([])
  const runner = agentAdapterToRunner(adapter)
  await runner.run("p", { executionId: "run-1:3:2" })
  assert.equal(requests[0]!.ctx.executionId, "run-1:3:2")
})

test("executionId 缺省 fallback：保持 UUID 形态（兼容旧调用方）", async () => {
  const { adapter, requests } = makeRecordingAdapter([])
  const runner = agentAdapterToRunner(adapter)
  await runner.run("p", {})
  assert.match(requests[0]!.ctx.executionId, /^[0-9a-f-]{36}$/)
})

test("tools 透传：AgentRunOptions.tools → AgentRequest.tools（含 mcp 策略，P0-1）", async () => {
  const { adapter, requests } = makeRecordingAdapter([])
  const runner = agentAdapterToRunner(adapter)
  const tools = {
    excludeTools: ["bash"],
    mcp: { enabled: true, servers: ["game"], allowTools: ["game:echo"], denyTools: ["game:delete_rules"] },
  }
  await runner.run("p", { tools })
  assert.deepEqual(requests[0]!.request.tools, tools)
  assert.equal(requests[0]!.request.tools?.mcp?.enabled, true)
  assert.deepEqual(requests[0]!.request.tools?.mcp?.servers, ["game"])
})

test("不传 tools 时 request.tools 缺省（与旧行为一致）", async () => {
  const { adapter, requests } = makeRecordingAdapter([])
  const runner = agentAdapterToRunner(adapter)
  await runner.run("p", {})
  assert.equal(requests[0]!.request.tools, undefined)
})

test("onToolCall 桥接：mcp-tool-call record 事件转窄回调，其他 record 不转", async () => {
  const summaries: McpToolCallSummary[] = []
  const otherRecords: unknown[] = []
  const { adapter } = makeRecordingAdapter([
    {
      emitRecord: (ctx) => {
        ctx.onEvent?.({
          type: "record",
          executionId: ctx.executionId,
          record: { kind: "mcp-tool-call", toolName: "mcp__fix__echo", status: "ok", argsBytes: 12 },
        } as never)
        ctx.onEvent?.({
          type: "record",
          executionId: ctx.executionId,
          record: { sessionId: "sess-1", textPreview: "x" },
        } as never)
      },
    },
  ])
  const runner = agentAdapterToRunner(adapter)
  const options: AgentRunOptions = {
    executionId: "run-2:1:1",
    onToolCall: (r) => summaries.push(r),
    // 模拟 runtime 既有的 record 消费者：非 mcp record 仍应可达（这里不传 onEvent，只验证不误转）
  }
  void otherRecords
  await runner.run("p", options)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0]!.toolName, "mcp__fix__echo")
  assert.equal(summaries[0]!.status, "ok")
})

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-mcp-"))
}

test("runtime 双落点：成功 attempt → journal entry.toolCalls", async () => {
  const dir = tmpProject()
  const summaries: McpToolCallSummary[] = []
  const journalEntries: Array<JournalEntry & { key: string }> = []
  const runner: import("../../src/engine/agent/session-runner.js").AgentSessionRunner = {
    async run(prompt, options) {
      // 模拟 Adapter 实时上报（事件侧）：工具执行完成
      options?.onToolCall?.({ toolName: "mcp__fix__echo", status: "ok", argsBytes: 20, argsKeys: ["text"], durationMs: 5 })
      return { value: `done:${prompt.slice(0, 10)}`, sessionId: "sess-a", type: "text" }
    },
  }
  const script = `export const meta = { name: 'mcp_journal' }\nawait agent('call echo')\nreturn 'done'`
  const result = await runWorkflow(script, {
    agent: runner,
    cwd: dir,
    runId: "mcp-j-1",
    onAgentJournal: (entry) => journalEntries.push(entry),
  })
  void result
  assert.equal(journalEntries.length, 1)
  const toolCalls = journalEntries[0]!.toolCalls
  assert.ok(Array.isArray(toolCalls), "entry.toolCalls 应为数组")
  assert.equal(toolCalls?.length, 1)
  assert.equal(toolCalls?.[0]?.toolName, "mcp__fix__echo")
})

test("runtime 双落点：失败 attempt → executions[].toolCalls（重试后失败，已发生调用不丢）", async () => {
  const dir = tmpProject()
  const executions: Array<{ key: string; execution: import("../../src/engine/types/index.js").AgentExecutionRecord }> = []
  const runner: import("../../src/engine/agent/session-runner.js").AgentSessionRunner = {
    async run(_prompt, options) {
      options?.onToolCall?.({ toolName: "mcp__fix__echo", status: "ok", argsBytes: 4, argsKeys: ["text"] })
      throw new Error("boom: simulated agent failure")
    },
  }
  const script = `export const meta = { name: 'mcp_fail' }\nawait agent('failing agent')\nreturn 'unreachable'`
  await assert.rejects(
    runWorkflow(script, {
      agent: runner,
      cwd: dir,
      runId: "mcp-j-2",
      agentRetries: 0,
      onAgentExecution: (payload) => executions.push(payload),
    }),
  )
  assert.equal(executions.length, 1)
  assert.equal(executions[0]!.execution.status, "failed")
  assert.equal(executions[0]!.execution.toolCalls?.length, 1)
  assert.equal(executions[0]!.execution.toolCalls?.[0]?.toolName, "mcp__fix__echo")
})

test("hash 身份：tools 不同 → callHash 不同（resume 指纹正确性）", async () => {
  const dir = tmpProject()
  const entries: Array<JournalEntry & { key: string }> = []
  const runner: import("../../src/engine/agent/session-runner.js").AgentSessionRunner = {
    async run(prompt) {
      return { value: `ok:${prompt.slice(0, 10)}`, sessionId: "sess-c", type: "text" }
    },
  }
  const base = "export const meta = { name: 'mcp_hash' }\n"
  const scriptNoTools = `${base}await agent('same prompt')\nreturn 'done'`
  const scriptWithTools = `${base}await agent('same prompt', { tools: { mcp: { enabled: true, servers: ['game'] } } })\nreturn 'done'`
  await runWorkflow(scriptNoTools, {
    agent: runner,
    cwd: dir,
    runId: "mcp-h-1",
    onAgentJournal: (entry) => entries.push({ ...entry }),
  })
  await runWorkflow(scriptWithTools, {
    agent: runner,
    cwd: dir,
    runId: "mcp-h-2",
    onAgentJournal: (entry) => entries.push({ ...entry }),
  })
  assert.equal(entries.length, 2)
  assert.notEqual(entries[0]!.hash, entries[1]!.hash)
})
