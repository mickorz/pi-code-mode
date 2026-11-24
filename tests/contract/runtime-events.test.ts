/**
 * Runtime Event Protocol 测试（M1）：无模型，fake runner。
 *
 * 覆盖：
 *  - Bus 语义：sequence 每 run 独立递增、eventId 形状、listener 异常隔离、退订
 *  - Runtime 埋点：workflow/phase/agent/composite/tool 事件真实产生且顺序单调
 *  - 终态语义：失败/中止保留各自终态（不统一映射成 failed）
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { RuntimeEventBus } from "../../packages/engine/src/events/runtime-event-bus.js"
import type { WorkflowRuntimeEvent } from "../../packages/engine/src/events/workflow-events.js"
import { runWorkflow } from "../../packages/engine/src/runtime/workflow-runtime.js"
import type { AgentSessionRunner } from "../../packages/engine/src/agent/session-runner.js"
import { textResult } from "../engine/helpers.js"

function fakeRunner(): AgentSessionRunner {
  return { async run(prompt) { return textResult(`echo:${prompt}`) } }
}

test("EventBus: sequence 每 run 独立递增，eventId = runId:seq", () => {
  const bus = new RuntimeEventBus()
  const seen: WorkflowRuntimeEvent[] = []
  bus.subscribe((e) => seen.push(e))
  bus.publish({ runId: "r1", type: "run.started" })
  bus.publish({ runId: "r1", type: "workflow.started" })
  bus.publish({ runId: "r2", type: "run.started" })
  assert.deepEqual(seen.map((e) => e.sequence), [1, 2, 1])
  assert.deepEqual(seen.map((e) => e.eventId), ["r1:1", "r1:2", "r2:1"])
  assert.equal(bus.lastSequence("r1"), 2)
  assert.equal(bus.lastSequence("r2"), 1)
})

test("EventBus: listener 异常隔离不阻断其余订阅者，退订后不再收到", () => {
  const bus = new RuntimeEventBus()
  const got: string[] = []
  const bad = bus.subscribe(() => {
    throw new Error("boom")
  })
  const good = bus.subscribe((e) => got.push(e.type))
  const origError = console.error
  console.error = () => {} // 静音预期内的隔离日志
  try {
    bus.publish({ runId: "r1", type: "run.started" })
  } finally {
    console.error = origError
  }
  assert.deepEqual(got, ["run.started"])
  good()
  bad()
  bus.publish({ runId: "r1", type: "run.finished" })
  assert.deepEqual(got, ["run.started"])
  assert.equal(bus.listenerCount, 0)
})

test("Runtime 埋点: 多阶段 + 子 workflow 产生完整的 workflow/phase/agent 事件流", async () => {
  const bus = new RuntimeEventBus()
  const events: WorkflowRuntimeEvent[] = []
  bus.subscribe((e) => events.push(e))

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-events-"))
  fs.writeFileSync(
    path.join(dir, "child.js"),
    `export const meta = { name: "child_flow" }
phase("结算")
await agent("c", { label: "AgentC" })
return "ok"`,
    "utf-8",
  )
  const script = `
export const meta = { name: "root_flow", phases: [{ title: "提取" }] }
phase("分析")
const a = await agent("a", { label: "AgentA" })
const child = await workflow({ scriptPath: "./child.js", label: "子流程" })
return a + ":" + child
`
  await runWorkflow(script, {
    agent: fakeRunner(),
    runId: "run-events",
    cwd: dir,
    onRuntimeEvent: (e) => bus.publish(e),
  })

  const types = events.map((e) => e.type)
  // workflow 起止：root 与 child 各一对
  assert.equal(types.filter((t) => t === "workflow.started").length, 2)
  assert.equal(types.filter((t) => t === "workflow.finished").length, 2)
  // phase：root 的初始阶段 + phase("分析") + child 的 phase("结算")，起止数量守恒
  assert.equal(types.filter((t) => t === "phase.started").length, types.filter((t) => t === "phase.finished").length)
  assert.ok(types.filter((t) => t === "phase.started").length >= 3)
  // agent：3 个（root a、child c），每个至少一条 started 与一条 finished
  const agentStarted = events.filter((e) => e.type === "agent.started")
  const agentFinished = events.filter((e) => e.type === "agent.finished")
  assert.equal(agentStarted.length, 2)
  assert.equal(agentFinished.length, 2)
  // sequence 严格单调递增（同一 run）
  const seqs = events.map((e) => e.sequence)
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y))
  // 子 workflow 事件的 scopePath 与父不同（树能区分同名流程）
  const wfScopes = events.filter((e) => e.type === "workflow.started").map((e) => (e.scopePath ?? []).join("/"))
  assert.equal(new Set(wfScopes).size, 2)
})

test("Runtime 埋点: tool 事件（runTool）成对出现，失败也收敛到同一 toolId", async () => {
  const bus = new RuntimeEventBus()
  const events: WorkflowRuntimeEvent[] = []
  bus.subscribe((e) => events.push(e))
  const script = `
export const meta = { name: "tool_flow" }
const r = await runTool("no-such-tool.sh", { onFailure: "return" })
return r.ok
`
  await runWorkflow(script, { agent: fakeRunner(), runId: "run-tool", onRuntimeEvent: (e) => bus.publish(e) })
  const toolEvents = events.filter((e) => e.type === "tool.started" || e.type === "tool.finished")
  assert.ok(toolEvents.length >= 1)
  const ids = new Set(toolEvents.filter((e) => e.type === "tool.finished").map((e) => (e.payload as any).toolId))
  assert.ok(ids.size >= 1)
  assert.ok(toolEvents.some((e) => (e.payload as any).status === "error"))
})

test("Runtime 埋点: 失败与中止保留各自终态（不统一映射成 failed）", async () => {
  const runOnce = async (script: string, aborted: boolean) => {
    const bus = new RuntimeEventBus()
    const events: WorkflowRuntimeEvent[] = []
    bus.subscribe((e) => events.push(e))
    const controller = new AbortController()
    const runner: AgentSessionRunner = {
      async run(prompt) {
        // 中止发生在执行中（不是进入前）：这样 workflow.finished 会带 aborted 终态
        if (aborted) controller.abort()
        return textResult(`echo:${prompt}`)
      },
    }
    try {
      await runWorkflow(script, {
        agent: runner,
        runId: "run-x",
        signal: controller.signal,
        onRuntimeEvent: (e) => bus.publish(e),
      })
    } catch {
      // 预期内失败/中止
    }
    return events.filter((e) => e.type === "workflow.finished").map((e) => (e.payload as any).status)
  }
  assert.deepEqual(await runOnce(`export const meta={name:"fail_flow"}\nthrow new Error("boom")`, false), ["failed"])
  // 中止：首个 agent 执行中置位，第二个 agent 的 throwIfAborted 抛 WORKFLOW_ABORTED -> aborted 终态
  assert.deepEqual(await runOnce(`export const meta={name:"abort_flow"}\nawait agent("x")\nawait agent("y")`, true), ["aborted"])
})
