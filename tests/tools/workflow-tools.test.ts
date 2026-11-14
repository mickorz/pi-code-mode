// workflow / workflow_control 工具测试（Mock Adapter，无 LLM）
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { RunManager } from "../../src/manager/run-manager.js"
import { makeWorkflowTool, makeWorkflowControlTool } from "../../src/tools/workflow-tools.js"
import type { AgentAdapter, AgentResult } from "../../src/adapter/types.js"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wftools-"))
}

function mockAdapter(script: { delayMs?: number; failOnPromptIncludes?: string } = {}): AgentAdapter {
  return {
    async execute(request: any): Promise<AgentResult> {
      if (request.signal?.aborted) {
        return { status: "cancelled", output: { type: "text", value: "" }, sessionId: "m" }
      }
      if (script.delayMs) {
        // 契约行为: signal 中止时提前返回 cancelled（对齐 PiAgentAdapter）
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, script.delayMs)
          request.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
        })
        if (request.signal?.aborted) {
          return { status: "cancelled", output: { type: "text", value: "" }, sessionId: "m" }
        }
      }
      if (script.failOnPromptIncludes && request.prompt.includes(script.failOnPromptIncludes)) {
        return { status: "error", output: { type: "text", value: "" }, sessionId: "m", error: { kind: "unknown", message: "mock 失败" } }
      }
      return { status: "ok", output: { type: "text", value: "mock-ok" }, usage: { inputTokens: 1, outputTokens: 1 }, sessionId: "mock-sid" }
    },
    async cancel() {},
  }
}

const META = "export const meta = { name: 't', description: 'test' }"

test("workflow 工具: inline 脚本执行成功并注册终态到 RunManager", async () => {
  const rm = new RunManager(4)
  const tool = makeWorkflowTool({ runManager: rm, adapterFactory: () => mockAdapter(), cwd: tmpDir() })
  const r = await (tool as any).execute("id", { script: `${META}\nreturn await agent('hi')` }, undefined, undefined, {})
  assert.match(r.content[0].text, /\[workflow 完成\]/)
  // 终态已入 recent，workflow_control 可查
  const list = await (makeWorkflowControlTool({ runManager: rm, adapterFactory: () => mockAdapter() }) as any).execute(
    "id",
    { action: "list" },
    undefined,
    undefined,
    {},
  )
  assert.match(list.content[0].text, /completed/)
})

test("workflow 工具: 缺 script/scriptPath 报参数错误", async () => {
  const tool = makeWorkflowTool({ runManager: new RunManager(), adapterFactory: () => mockAdapter(), cwd: tmpDir() })
  const r = await (tool as any).execute("id", {}, undefined, undefined, {})
  assert.match(r.content[0].text, /必须提供 script 或 scriptPath/)
})

test("workflow 工具: 无 meta 的脚本被校验拦截", async () => {
  const tool = makeWorkflowTool({ runManager: new RunManager(), adapterFactory: () => mockAdapter(), cwd: tmpDir() })
  const r = await (tool as any).execute("id", { script: "return 1" }, undefined, undefined, {})
  assert.match(r.content[0].text, /脚本校验失败/)
})

test("workflow 工具: agent 失败 -> failed 终态带错误", async () => {
  const rm = new RunManager(4)
  const tool = makeWorkflowTool({ runManager: rm, adapterFactory: () => mockAdapter({ failOnPromptIncludes: "hi" }), cwd: tmpDir() })
  const r = await (tool as any).execute("id", { script: `${META}\nreturn await agent('hi')` }, undefined, undefined, {})
  assert.match(r.content[0].text, /\[workflow 失败\]/)
  assert.match(r.details.error, /mock 失败/)
})

test("workflow_control: status 查询在途 run 的节点进度", async () => {
  const rm = new RunManager(4)
  // 慢 adapter：在途期间查询 status
  const tool = makeWorkflowTool({ runManager: rm, adapterFactory: () => mockAdapter({ delayMs: 300 }), cwd: tmpDir() })
  const pending = (tool as any).execute("id", { script: `${META}\nawait agent('a')\nawait agent('b')` }, undefined, undefined, {})
  await new Promise((r) => setTimeout(r, 100))
  const control = makeWorkflowControlTool({ runManager: rm, adapterFactory: () => mockAdapter() })
  const s = await (control as any).execute("id", { action: "status", runId: rm.list().find((x: any) => x.status === "running")!.runId }, undefined, undefined, {})
  assert.match(s.content[0].text, /进行中/)
  const l = await (control as any).execute("id", { action: "list" }, undefined, undefined, {})
  assert.match(l.content[0].text, /在途/)
  await pending
})

test("workflow_control: cancel 取消在途 run -> workflow 返回已取消", async () => {
  const rm = new RunManager(4)
  const tool = makeWorkflowTool({ runManager: rm, adapterFactory: () => mockAdapter({ delayMs: 500 }), cwd: tmpDir() })
  const pending = (tool as any).execute("id", { script: `${META}\nawait agent('slow')` }, undefined, undefined, {})
  await new Promise((r) => setTimeout(r, 80))
  const runId = rm.list().find((x: any) => x.status === "running")!.runId
  const control = makeWorkflowControlTool({ runManager: rm, adapterFactory: () => mockAdapter() })
  const c = await (control as any).execute("id", { action: "cancel", runId }, undefined, undefined, {})
  assert.match(c.content[0].text, /已发送取消信号/)
  const done = await pending
  assert.match(done.content[0].text, /已取消/)
})

test("workflow_control: cancel 未知 runId 返回未找到", async () => {
  const control = makeWorkflowControlTool({ runManager: new RunManager(), adapterFactory: () => mockAdapter() })
  const r = await (control as any).execute("id", { action: "cancel", runId: "nope" }, undefined, undefined, {})
  assert.match(r.content[0].text, /未找到在途 run/)
})
