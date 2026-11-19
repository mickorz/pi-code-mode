/**
 * 评审修复回归测试（H1/H2/M2/M3/M4）。
 *
 * 每个用例对应一条评审结论，命名带编号便于追溯：
 *   H1 Journal 详情实时（共用 JournalStore 实例）
 *   H2 run 往返切换后导航仍指向正确树
 *   M1 子 workflow 内 runTool 挂到真实 phase（display 标题）
 *   M2 失败 attempt 写入 journal（onAgentExecution 接线）
 *   M3 详情 End / 连续 ↓ 滚动被钳制（不越界白屏）
 *   M4 Agents/Tools Tab 列表不受树折叠影响，且键盘在列表内移动
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { RuntimeEventBus } from "../../src/engine/events/runtime-event-bus.js"
import { RunManager } from "../../src/manager/run-manager.js"
import { createRunJournal } from "../../src/manager/run-journal.js"
import { runWorkflow } from "../../src/engine/runtime/workflow-runtime.js"
import { ExplorerController } from "../../src/explorer/controller/explorer-controller.js"
import { NavigationModel } from "../../src/explorer/model/navigation-model.js"
import type { AgentSessionRunner } from "../../src/engine/agent/session-runner.js"
import { textResult } from "../engine/helpers.js"

function tmpProject(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function put(dir: string, rel: string, content: string): void {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, "utf-8")
}

const echoRunner: AgentSessionRunner = { async run(prompt) { return textResult(`echo:${prompt}`) } }

test("H1: 共用 JournalStore 时运行中新增的 journal 条目立刻可读（详情不陈旧）", async () => {
  const dir = tmpProject("fix-h1-")
  const bus = new RuntimeEventBus()
  const rm = new RunManager(4, bus)
  const journal = createRunJournal(dir)
  const runId = "run-h1"

  rm.register(runId, { label: "h1" })
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, cwd: dir, journal })
  explorer.open(() => {})

  // agent 首次完成前：详情无 journal 数据
  await runWorkflow(`export const meta = { name: "h1_flow" }\nawait agent("task one", { label: "A1" })\nreturn "ok"`, {
    agent: echoRunner,
    runId,
    cwd: dir,
    onAgentJournal: (entry: any) => journal.append(runId, entry.key, entry),
    onRuntimeEvent: (e: any) => bus.publish(e),
  })

  const agentKey = explorer.view().rows.find((r) => r.kind === "agent")!.nodeKey
  // 第一次读取不应再需要新建 store（共用实例），且能读到刚落盘的条目
  const detail = explorer.detailFor(agentKey)
  assert.ok(detail?.agent, "共用实例能读到 journal 条目")
  assert.equal(detail?.agent?.result, "echo:task one")

  // 追加第二条后立刻可见（同一实例缓存被写入方原地更新）
  await runWorkflow(`export const meta = { name: "h1_flow" }\nawait agent("task two", { label: "A2" })\nreturn "ok"`, {
    agent: echoRunner,
    runId,
    cwd: dir,
    onAgentJournal: (entry: any) => journal.append(runId, entry.key, entry),
    onRuntimeEvent: (e: any) => bus.publish(e),
  })
  const a2 = explorer.view().rows.find((r) => r.label === "A2")!
  assert.equal(explorer.detailFor(a2.nodeKey)?.agent?.result, "echo:task two", "后续写入立即可见（无陈旧缓存）")
  explorer.dispose()
})

test("H2: r1 -> r2 -> r1 往返切换后，导航仍指向当前 run 的树", () => {
  const bus = new RuntimeEventBus()
  const rm = new RunManager(4, bus)
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, journalDir: "/tmp/none" })

  const seed = (runId: string, label: string) => {
    rm.register(runId, { label })
    bus.publish({
      runId,
      type: "workflow.started",
      scopePath: ["root"],
      payload: { name: `${runId}_flow`, label, scopePath: ["root"], startedAt: Date.now(), status: "running" },
    })
    bus.publish({
      runId,
      type: "agent.started",
      scopePath: ["root"],
      payload: { id: `${runId}:0`, label: `${label}-agent`, status: "running", workflowScopePath: ["root"] },
    })
  }
  seed("r1", "first")
  seed("r2", "second")

  explorer.open(() => {})
  assert.equal(explorer.selectRun("r1"), true)
  const r1Labels = explorer.view().rows.map((r) => r.label)
  assert.ok(r1Labels.includes("first-agent"))

  assert.equal(explorer.selectRun("r2"), true)
  assert.ok(explorer.view().rows.some((r) => r.label === "second-agent"))

  // 关键：切回已存在树的 r1
  assert.equal(explorer.selectRun("r1"), true)
  const back = explorer.view()
  assert.ok(back.rows.some((r) => r.label === "first-agent"), "切回后树是 r1 的")
  assert.ok(!back.rows.some((r) => r.label === "second-agent"), "不得残留 r2 的节点")
  assert.equal(back.activeRunId, "r1")
  assert.ok(back.selected, "切回后仍有选中节点（不空）")
  assert.ok(back.selected!.runId === "r1", "选中节点属于 r1")
  explorer.dispose()
})

test("M1: 子 workflow 内 runTool 挂到真实 phase（display 标题），节点可见", async () => {
  const dir = tmpProject("fix-m1-")
  put(dir, "probe.py", "print('ok')\n")
  put(
    dir,
    "child.js",
    `export const meta = { name: "child_tool" }
phase("子阶段")
await runTool("./probe.py", { onFailure: "return" })
await agent("child task", { label: "ChildAgent" })
return "child"`,
  )
  const bus = new RuntimeEventBus()
  const rm = new RunManager(4, bus)
  rm.register("run-m1", { label: "m1" })
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, cwd: dir, journalDir: path.join(dir, "j") })
  explorer.open(() => {})

  await runWorkflow(
    `export const meta = { name: "root_m1" }
await workflow({ scriptPath: "./child.js", label: "Child" })
return "ok"`,
    { agent: echoRunner, runId: "run-m1", cwd: dir, onRuntimeEvent: (e: any) => bus.publish(e) },
  )

  const rows = explorer.view().rows
  const tool = rows.find((r) => r.kind === "tool")
  assert.ok(tool, "tool 节点在树中可见（不再挂到不存在的 phase）")
  const phase = rows.find((r) => r.kind === "phase" && r.label.includes("子阶段"))
  assert.ok(phase, "真实 phase 节点存在")
  assert.equal(tool!.parentKey, phase!.nodeKey, "tool 挂在对应 phase 下")
  explorer.dispose()
})

test("M2: 失败 attempt 写入 journal（详情 executions 非空）", async () => {
  const dir = tmpProject("fix-m2-")
  const journal = createRunJournal(dir)
  const bus = new RuntimeEventBus()
  const rm = new RunManager(4, bus)
  const runId = "run-m2"
  rm.register(runId, { label: "m2" })

  let calls = 0
  const flakyRunner: AgentSessionRunner = {
    async run(prompt) {
      calls++
      if (calls === 1) throw new Error("first attempt failed")
      return textResult(`echo:${prompt}`)
    },
  }

  await runWorkflow(`export const meta = { name: "m2_flow" }\nawait agent("flaky task", { label: "Flaky", retries: 1 })\nreturn "ok"`, {
    agent: flakyRunner,
    runId,
    cwd: dir,
    agentRetries: 1,
    onAgentJournal: (entry: any) => journal.append(runId, entry.key, entry),
    onAgentExecution: (p: any) => journal.recordExecution(runId, p.key, p.execution),
    onRuntimeEvent: (e: any) => bus.publish(e),
  }).catch(() => undefined)

  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, cwd: dir, journal })
  explorer.open(() => {})
  const agent = explorer.view().rows.find((r) => r.kind === "agent")
  assert.ok(agent, "agent 节点存在")
  const detail = explorer.detailFor(agent!.nodeKey)
  assert.ok(detail?.agent, "journal 有该 agent 的记录")
  assert.ok(detail!.agent!.executions.length >= 1, "失败 attempt 已写入 executions")
  assert.equal(detail!.agent!.executions[0].status, "failed")
  explorer.dispose()
})

test("M3: 详情 End / 连续 ↓ 被钳制到最大滚动起点（不越界白屏）", () => {
  const fakes: Record<string, any> = {}
  for (let i = 0; i < 30; i++) fakes[`k${i}`] = { nodeKey: `k${i}`, runId: "r", kind: "agent", label: `k${i}`, status: "ok", scopePath: ["root"], children: [], createdSequence: i, updatedSequence: i }
  const nav = new NavigationModel({
    rootKey: () => "k0",
    node: (key) => fakes[key],
  })
  nav.state.focus = "detail"
  nav.setDetailMaxScroll(7) // 内容 10 行、视口 3 行 -> 最大起点 7

  for (const effect of nav.end()) assert.equal(effect.kind, "redraw")
  assert.equal(nav.state.detailScrollTop, 7, "End 钳到最大起点")

  nav.down()
  assert.equal(nav.state.detailScrollTop, 7, "已在末尾时 ↓ 不越界")

  nav.up()
  assert.equal(nav.state.detailScrollTop, 6, "从真实末尾回退一位（不是从 MAX_SAFE_INTEGER）")

  nav.setDetailMaxScroll(0)
  assert.equal(nav.state.detailScrollTop, 0, "内容变短时滚动位置回收")
})

test("M4: Agents/Tools Tab 列表不受树折叠影响，键盘在列表内移动", () => {
  const bus = new RuntimeEventBus()
  const rm = new RunManager(4, bus)
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, journalDir: "/tmp/none" })
  rm.register("r1", { label: "r1" })
  bus.publish({
    runId: "r1",
    type: "workflow.started",
    scopePath: ["root"],
    payload: { name: "root_flow", label: "root_flow", scopePath: ["root"], startedAt: 1, status: "running" },
  })
  bus.publish({
    runId: "r1",
    type: "phase.started",
    scopePath: ["root"],
    payload: { phaseId: "root#批处理", title: "批处理", scopePath: ["root"], status: "running", startedAt: 1 },
  })
  bus.publish({
    runId: "r1",
    type: "agent.started",
    scopePath: ["root"],
    payload: { id: "r1:0", label: "HiddenA", phase: "批处理", status: "running", workflowScopePath: ["root"] },
  })
  bus.publish({
    runId: "r1",
    type: "agent.started",
    scopePath: ["root"],
    payload: { id: "r1:1", label: "HiddenB", phase: "批处理", status: "running", workflowScopePath: ["root"] },
  })
  bus.publish({
    runId: "r1",
    type: "run.finished",
    payload: { status: "completed" },
  })
  explorer.open(() => {})
  const nav = explorer.nav
  nav.ensureSelection()

  // 折叠整个 workflow（树里 agents 全部不可见）
  const wf = nav.visibleRows().find((r) => r.kind === "workflow")!
  nav.select(wf.nodeKey)
  nav.left()
  assert.ok(!explorer.view().rows.some((r) => r.kind === "agent"), "树里已折叠掉 agent")

  // 切到 Agents Tab：列表仍完整（来自全树，不受折叠影响）
  nav.setTab("agents")
  let view = explorer.view()
  assert.equal(view.listRows.length, 2, "Agents Tab 仍列出 2 个 agent")
  assert.equal(view.listSelectedIndex, 0, "Tab 列表有选中高亮")

  // 键盘在列表内移动
  explorer.handleKey("down")
  view = explorer.view()
  assert.equal(view.listRows[view.listSelectedIndex].label, "HiddenB", "↓ 在 Tab 列表内移动")
  explorer.handleKey("up")
  view = explorer.view()
  assert.equal(view.listRows[view.listSelectedIndex].label, "HiddenA", "↑ 回到上一项")
  explorer.dispose()
})

test("L1: resume 复用 runId 时重建树（上一代节点不残留）", () => {
  const bus = new RuntimeEventBus()
  const rm = new RunManager(4, bus)
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, journalDir: "/tmp/none" })
  rm.register("r1", { label: "first-incarnation" })
  bus.publish({
    runId: "r1",
    type: "workflow.started",
    scopePath: ["root"],
    payload: { name: "root_flow", label: "root_flow", scopePath: ["root"], startedAt: 1, status: "running" },
  })
  bus.publish({
    runId: "r1",
    type: "agent.started",
    scopePath: ["root"],
    payload: { id: "r1:0", label: "OldAgent", status: "running", workflowScopePath: ["root"] },
  })
  explorer.open(() => {})
  assert.ok(explorer.view().rows.some((r) => r.label === "OldAgent"))

  // 新一代（resume 同 runId）
  rm.register("r1", { label: "second-incarnation" })
  bus.publish({
    runId: "r1",
    type: "workflow.started",
    scopePath: ["root"],
    payload: { name: "root_flow", label: "root_flow", scopePath: ["root"], startedAt: 2, status: "running" },
  })
  const rows = explorer.view().rows
  assert.ok(!rows.some((r) => r.label === "OldAgent"), "上一代节点已清除")
  assert.ok(rows.some((r) => r.kind === "workflow"), "新一代 workflow 节点存在")
  explorer.dispose()
})

test("H3: schedule 触发的 run 也产生执行树与 journal（已接线 eventBus/journal）", async () => {
  const dir = tmpProject("fix-h3-")
  const bus = new RuntimeEventBus()
  const rm = new RunManager(4, bus)
  const journal = createRunJournal(dir)
  const { PiScheduleRunner } = await import("../../src/manager/pi-schedule-runner.js")
  const { MockAgentAdapter } = await import("./mock-adapter.js")

  const runner = new PiScheduleRunner({
    runManager: rm,
    cwd: dir,
    eventBus: bus,
    journal,
    // 注入 mock adapter：不建真实子会话、不调模型
    agentFactory: () => new MockAgentAdapter({ default: { status: "ok", output: { type: "text", value: "mock" } } as any }),
  })

  const runId = runner.start(
    { directory: dir } as any,
    {
      script: `export const meta = { name: "sched_flow", phases: [{ title: "阶段一" }] }
await agent("scheduled task", { label: "SchedAgent" })
return "done"`,
      args: undefined,
      trigger: { type: "schedule", scheduleId: "sc1" },
    } as any,
  )

  // 等完成（mock 立即返回）
  for (let i = 0; i < 100 && rm.getSnapshot(runId)!.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 20))
  }

  const snap = rm.getSnapshot(runId)!
  assert.equal(snap.status, "completed")
  assert.ok(snap.workflows.length >= 1, "schedule run 有 workflow 记录（事件已接线）")
  assert.ok(snap.agents.length >= 1, "schedule run 有 agent 记录")
  assert.ok(snap.phases.length >= 1, "schedule run 有 phase 记录")

  // journal 也落盘（同一实例）
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, cwd: dir, journal })
  explorer.open(() => {})
  explorer.selectRun(runId)
  const agent = explorer.view().rows.find((r) => r.kind === "agent")
  assert.ok(agent, "Explorer 能看到 schedule run 的 agent 节点")
  assert.ok(explorer.detailFor(agent!.nodeKey)?.agent, "详情能从 journal 读到结果")
  explorer.dispose()
})
