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

test("workflow_control: stop 停止在途 run -> workflow 返回已停止（journal 保留提示）", async () => {
  const rm = new RunManager(4)
  const tool = makeWorkflowTool({ runManager: rm, adapterFactory: () => mockAdapter({ delayMs: 500 }), cwd: tmpDir() })
  const pending = (tool as any).execute("id", { script: `${META}\nawait agent('slow')` }, undefined, undefined, {})
  await new Promise((r) => setTimeout(r, 80))
  const runId = rm.list().find((x: any) => x.status === "running")!.runId
  const control = makeWorkflowControlTool({ runManager: rm, adapterFactory: () => mockAdapter() })
  const c = await (control as any).execute("id", { action: "stop", runId }, undefined, undefined, {})
  assert.match(c.content[0].text, /已停止 run/)
  assert.match(c.content[0].text, /resumeFromRunId/)
  const done = await pending
  assert.match(done.content[0].text, /已停止/)
})

test("workflow_control: stop 未知 runId 返回未找到", async () => {
  const control = makeWorkflowControlTool({ runManager: new RunManager(), adapterFactory: () => mockAdapter() })
  const r = await (control as any).execute("id", { action: "stop", runId: "nope" }, undefined, undefined, {})
  assert.match(r.content[0].text, /未找到运行中的 run/)
})

test("workflow 工具: background=true 立即返回 runId，后台完成后 deliver 回传", async () => {
  const rm = new RunManager(4)
  const delivered: string[] = []
  const deliver = async (text: string) => {
    delivered.push(text)
  }
  const tool = makeWorkflowTool({ runManager: rm, adapterFactory: () => mockAdapter({ delayMs: 200 }), cwd: tmpDir(), deliver })
  const r = await (tool as any).execute("id", { script: `${META}
await agent('bg')`, background: true }, undefined, undefined, {})
  assert.match(r.content[0].text, /runId=/)
  assert.match(r.content[0].text, /\/workflows watch run-/) // 提交文案带可直接复制的 watch 命令
  // 等后台完成 + deliver
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /\[workflow 完成\]/)
  assert.equal(rm.list()[0]?.status, "completed")
})

test("workflow 工具: resumeFromRunId 透传（journal 加载 + runId 复用）", async () => {
  const rm = new RunManager(4)
  // 先造一个 journal 文件
  const dir = tmpDir()
  const journalDir = path.join(dir, ".pi", "workflows", "journal")
  fs.mkdirSync(journalDir, { recursive: true })
  const oldRunId = "run-old-123"
  fs.writeFileSync(
    path.join(journalDir, `${oldRunId}.json`),
    JSON.stringify({
      version: 1,
      runId: oldRunId,
      entries: {
        [`${oldRunId}:0`]: {
          key: `${oldRunId}:0`,
          hash: "nomatch-hash",
          result: "cached",
          label: "A",
          prompt: "旧 prompt",
        },
      },
    }),
  )
  const tool = makeWorkflowTool({ runManager: rm, adapterFactory: () => mockAdapter(), cwd: dir })
  const r = await (tool as any).execute(
    "id",
    { script: `${META}
await agent('新 prompt')`, resumeFromRunId: oldRunId },
    undefined,
    undefined,
    {},
  )
  // hash 不匹配 -> 重跑（但 journal key 对齐，即 runId 复用旧值）
  assert.match(r.content[0].text, /\[workflow 完成\] runId=run-old-123/)
})

test("workflow 工具: concurrency 透传 runWorkflow", async () => {
  const rm = new RunManager(16)
  const tool = makeWorkflowTool({ runManager: rm, adapterFactory: () => mockAdapter(), cwd: tmpDir() })
  const r = await (tool as any).execute(
    "id",
    { script: `${META}
const rs = await parallel([() => agent('1'), () => agent('2')])
return rs.length`, concurrency: 2 },
    undefined,
    undefined,
    {},
  )
  assert.match(r.content[0].text, /\[workflow 完成\]/)
})

test("checkpoint 通道: ui.confirm 存在时接线（无宿主环境走 headless 缺省）", async () => {
  const rm = new RunManager(4)
  // execute 的 ctx 未传 ui -> confirm undefined -> 引擎 headless default（checkpoint 默认通过）
  const script = `${META}
const gate = await checkpoint('继续吗？')
return { gate }`
  const tool = makeWorkflowTool({ runManager: rm, adapterFactory: () => mockAdapter(), cwd: tmpDir() })
  const r = await (tool as any).execute("id", { script }, undefined, undefined, {})
  assert.match(r.content[0].text, /\[workflow 完成\]/)
  assert.match(r.content[0].text, /gate/)
})
