/**
 * ExplorerController 测试（M4）：单实例常驻语义 + 导航状态不丢。
 *
 * 关键断言（架构设计 §3.2 / §9.3）：
 *  - 关闭（hide）再打开不丢选中节点、Tab、展开态
 *  - 后台事件到达不改变选中节点
 *  - 切 Tab 不清空树展开态
 *  - 切 run 保留各 run 自己的树
 *  - Overlay 视图契约：open(requestRender) / hide() 只影响可见性，不销毁状态
 */

import test from "node:test"
import assert from "node:assert/strict"
import { RuntimeEventBus } from "../../packages/engine/src/events/runtime-event-bus.js"
import { RunManager } from "../../packages/manager/src/run-manager.js"
import { ExplorerController } from "../../packages/explorer/src/controller/explorer-controller.js"

/** 构造一个已注册 run + 一条 workflow/phase/agent 事件链 */
function seedRun(rm: RunManager, bus: RuntimeEventBus, runId: string, agentLabels = ["A1"]) {
  rm.register(runId, { label: runId })
  const seqBase = bus.lastSequence(runId)
  void seqBase
  bus.publish({
    runId,
    type: "workflow.started",
    scopePath: ["root"],
    payload: { name: "root_flow", label: "root_flow", scopePath: ["root"], startedAt: Date.now(), status: "running" },
  })
  bus.publish({
    runId,
    type: "phase.started",
    scopePath: ["root"],
    payload: { phaseId: "root#实现", title: "实现", scopePath: ["root"], status: "running", startedAt: Date.now() },
  })
  agentLabels.forEach((label, i) => {
    bus.publish({
      runId,
      type: "agent.started",
      scopePath: ["root"],
      payload: { id: `${runId}:${i}`, label, phase: "实现", status: "running", workflowScopePath: ["root"] },
    })
  })
}

test("Controller: 关闭再打开保持选中节点与 Tab（逻辑单实例常驻）", () => {
  const bus = new RuntimeEventBus()
  const rm = new RunManager(2, bus)
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, journalDir: "/tmp/none" })
  seedRun(rm, bus, "r1", ["A1", "A2"])

  let renders = 0
  explorer.open(() => renders++)
  const nav = explorer.nav!
  nav.ensureSelection()
  const rows = nav.visibleRows()
  assert.ok(rows.length >= 3, "树已展开可见 workflow/phase/agent")
  // 选中第二个 agent 并展开 phase
  const agentRow = rows.find((r) => r.label === "A2")!
  nav.select(agentRow.nodeKey)
  nav.openDetail()
  const selectedBefore = nav.state.selectedNodeKey

  explorer.hide()
  assert.equal(explorer.isVisible, false)

  // 重新打开：状态不丢
  explorer.open(() => renders++)
  assert.equal(explorer.nav!.state.selectedNodeKey, selectedBefore, "选中节点保持")
  assert.equal(explorer.nav!.state.view, "detail", "视图态保持（详情）")
  explorer.dispose()
})

test("Controller: 后台事件到达不改变选中节点", () => {
  const bus = new RuntimeEventBus()
  const rm = new RunManager(2, bus)
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, journalDir: "/tmp/none" })
  seedRun(rm, bus, "r1", ["A1", "A2"])
  explorer.open(() => {})
  const nav = explorer.nav!
  nav.ensureSelection()
  const firstAgent = nav.visibleRows().find((r) => r.kind === "agent")!
  nav.select(firstAgent.nodeKey)

  // 后台高频更新（另一个 agent 完成 + phase 切换）
  bus.publish({
    runId: "r1",
    type: "agent.finished",
    scopePath: ["root"],
    payload: { id: "r1:1", label: "A2", phase: "实现", status: "ok", workflowScopePath: ["root"], durationMs: 12 },
  })
  bus.publish({
    runId: "r1",
    type: "phase.started",
    scopePath: ["root"],
    payload: { phaseId: "root#测试", title: "测试", scopePath: ["root"], status: "running", startedAt: Date.now() },
  })
  assert.equal(nav.state.selectedNodeKey, firstAgent.nodeKey, "后台更新不得抢走焦点")
  explorer.dispose()
})

test("Controller: 详情/树两态切换不清空树展开态", () => {
  const bus = new RuntimeEventBus()
  const rm = new RunManager(2, bus)
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, journalDir: "/tmp/none" })
  seedRun(rm, bus, "r1", ["A1"])
  explorer.open(() => {})
  const nav = explorer.nav!
  nav.ensureSelection()
  const wf = nav.visibleRows().find((r) => r.kind === "workflow")!
  nav.select(wf.nodeKey)
  nav.left() // 收起
  const collapsed = nav.visibleRows().length
  // 进详情再返回树：展开态不变（B2 两态满屏）
  nav.openDetail()
  assert.equal(nav.state.view, "detail")
  nav.escape()
  assert.equal(nav.state.view, "tree")
  assert.equal(nav.visibleRows().length, collapsed, "详情往返不影响展开态")
  explorer.dispose()
})

test("Controller: 切 run 保留各 run 自己的树，未知 run 返回 false", () => {
  const bus = new RuntimeEventBus()
  const rm = new RunManager(2, bus)
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, journalDir: "/tmp/none" })
  seedRun(rm, bus, "r1", ["A1"])
  seedRun(rm, bus, "r2", ["B1", "B2"])
  explorer.open(() => {})
  assert.equal(explorer.selectRun("r2"), true)
  assert.equal(explorer.activeRun, "r2")
  const labels = explorer.view().rows.map((r) => r.label)
  assert.ok(labels.includes("B1") && labels.includes("B2"))
  assert.equal(explorer.selectRun("ghost"), false)
  assert.equal(explorer.activeRun, "r2", "未知 run 不改变当前定位")
  explorer.dispose()
})

test("Controller: 导航动作（上下左右/详情/返回）语义", () => {
  const bus = new RuntimeEventBus()
  const rm = new RunManager(2, bus)
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, journalDir: "/tmp/none" })
  seedRun(rm, bus, "r1", ["A1", "A2"])
  explorer.open(() => {})
  const nav = explorer.nav!
  nav.ensureSelection()
  const wf = nav.visibleRows().find((r) => r.kind === "workflow")!
  nav.select(wf.nodeKey)

  explorer.handleKey("down") // → phase
  const afterDown = nav.state.selectedNodeKey
  assert.equal(nav.selectedNode?.kind, "phase", "down 选中 phase")

  explorer.handleKey("enter") // Enter 打开全屏详情
  assert.equal(nav.state.view, "detail")
  explorer.handleKey("right") // 详情态右 → 下一个节点
  assert.notEqual(nav.state.selectedNodeKey, afterDown, "详情态 right 切换节点")

  explorer.handleKey("escape")
  assert.equal(nav.state.view, "tree", "esc 从详情回到树")

  explorer.handleKey("left") // 无子节点且已收起 → 回到父级
  assert.ok(nav.selectedNode, "left 回到父节点")

  const closeEffects = explorer.handleKey("escape")
  assert.deepEqual(closeEffects.map((e) => e.kind), ["close"], "树模式下 esc 请求关闭面板")
  explorer.dispose()
})

test("Controller: dispose 后不再订阅事件（不泄漏）", () => {
  const bus = new RuntimeEventBus()
  const rm = new RunManager(2, bus)
  const before = bus.listenerCount
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, journalDir: "/tmp/none" })
  assert.equal(bus.listenerCount, before + 1, "controller 订阅（RunManager 的构造订阅已在 before 内）")
  explorer.dispose()
  assert.equal(bus.listenerCount, before, "dispose 后只剩 RunManager 的订阅")
})
