/**
 * Explorer Overlay 适配器测试（M4 TUI 层）：fake 宿主 ui，不启动真实 TUI。
 *
 * 覆盖：overlay 参数（右侧栏 + 宽度）、组件 render/handleInput 键映射、
 * q 关闭、esc 在树模式关闭、详情态 esc 返回树不关闭、j/k 别名、
 * dispose 只隐藏视图不销毁状态（重开后恢复选中）。
 */

import test from "node:test"
import assert from "node:assert/strict"
import { openExplorer, closeExplorer } from "../../extensions/explorer/index.js"
import { RuntimeEventBus } from "../../src/engine/events/runtime-event-bus.js"
import { RunManager } from "../../src/manager/run-manager.js"
import { ExplorerController } from "../../src/explorer/controller/explorer-controller.js"

/** fake 宿主 ui.custom：捕获 factory + options，返回可驱动的 component */
function fakeUi() {
  const captured: { component?: any; options?: any; doneCalls: number; notices: string[] } = {
    doneCalls: 0,
    notices: [],
  }
  const ui = {
    notify: (m: string) => captured.notices.push(m),
    custom: async (factory: any, options: any) => {
      captured.options = options
      let doneCalled = 0
      const done = () => {
        doneCalled++
        captured.doneCalls = doneCalled
      }
      captured.component = factory({ requestRender: () => {}, terminal: { rows: 30 } }, {}, {}, done)
      // dispose 模拟宿主关闭 overlay
      captured.component.dispose?.()
    },
  }
  return { ui, captured }
}

function seed() {
  const bus = new RuntimeEventBus()
  const rm = new RunManager(4, bus)
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, journalDir: "/tmp/none" })
  rm.register("r1", { label: "r1" })
  bus.publish({
    runId: "r1",
    type: "workflow.started",
    scopePath: ["root"],
    payload: { name: "root_flow", label: "root_flow", scopePath: ["root"], startedAt: Date.now(), status: "running" },
  })
  bus.publish({
    runId: "r1",
    type: "phase.started",
    scopePath: ["root"],
    payload: { phaseId: "root#实现", title: "实现", scopePath: ["root"], status: "running", startedAt: Date.now() },
  })
  bus.publish({
    runId: "r1",
    type: "agent.started",
    scopePath: ["root"],
    payload: { id: "r1:0", label: "AgentA", phase: "实现", status: "running", workflowScopePath: ["root"] },
  })
  return { bus, rm, explorer }
}

test("Overlay: 右侧栏定位 + 宽度参数 + 首帧可渲染", async () => {
  const { explorer } = seed()
  const { ui, captured } = fakeUi()
  await openExplorer(explorer, ui)
  assert.ok(captured.options.overlay, "overlay 模式")
  assert.equal(captured.options.overlayOptions().anchor, "right-center", "右侧栏锚点")
  assert.equal(captured.options.overlayOptions().width, "60%")
  const lines = captured.component.render(100)
  assert.ok(lines.length > 3)
  assert.ok(lines.join("\n").includes("Workflow Explorer"), "标题可见")
  explorer.dispose()
})

test("Overlay: q 关闭；关闭只 hide 视图，重开恢复选中节点", async () => {
  const { explorer } = seed()
  const { ui, captured } = fakeUi()
  await openExplorer(explorer, ui)
  // 打开后默认选中第一个 workflow；先切到 agent 行
  explorer.nav!.ensureSelection()
  const agentRow = explorer.nav!.visibleRows().find((r) => r.kind === "agent")!
  explorer.nav!.select(agentRow.nodeKey)
  const selected = explorer.nav!.state.selectedNodeKey

  captured.component.handleInput("q")
  assert.equal(captured.doneCalls, 1, "q 触发 done（关闭 overlay）")
  assert.equal(explorer.isVisible, false, "dispose 后视图隐藏")

  const second = fakeUi()
  await openExplorer(explorer, second.ui)
  assert.equal(explorer.nav!.state.selectedNodeKey, selected, "重开保持选中节点")
  explorer.dispose()
})

test("Overlay: esc/q 树模式关闭、详情态 esc 返回树；j/k 为上下别名", async () => {
  const { explorer } = seed()
  const { ui, captured } = fakeUi()
  await openExplorer(explorer, ui)
  const nav = explorer.nav!
  nav.ensureSelection()
  const wf = nav.visibleRows().find((r) => r.kind === "workflow")!
  nav.select(wf.nodeKey)

  captured.component.handleInput("\x1b[B") // down → phase
  assert.equal(nav.selectedNode?.kind, "phase")
  captured.component.handleInput("k") // up 别名 → 回到 workflow
  assert.equal(nav.selectedNode?.kind, "workflow")

  captured.component.handleInput("o") // o → 全屏详情（B3：enter 只展开，详情走 o）
  assert.equal(nav.state.view, "detail")
  captured.component.handleInput("\x1b") // esc → 回树，不关闭
  assert.equal(nav.state.view, "tree")
  assert.equal(captured.doneCalls, 0, "详情态 esc 不关闭面板")

  captured.component.handleInput("\x1b") // 树模式 esc → 关闭
  assert.equal(captured.doneCalls, 1)
  explorer.dispose()
})

test("Overlay: r 键在多个 run 间轮换", async () => {
  const { bus, rm, explorer } = seed()
  rm.register("r2", { label: "r2" })
  bus.publish({
    runId: "r2",
    type: "workflow.started",
    scopePath: ["root"],
    payload: { name: "other", label: "other", scopePath: ["root"], startedAt: Date.now(), status: "running" },
  })
  const { ui, captured } = fakeUi()
  await openExplorer(explorer, ui, { runId: "r1" })
  assert.equal(explorer.activeRun, "r1")
  captured.component.handleInput("r")
  assert.equal(explorer.activeRun, "r2", "r 轮换到下一个 run")
  explorer.dispose()
})

test("Overlay: 详情态 PgUp/PgDn 按视口翻页滚动（↑ 已改为返回树）", async () => {
  const { explorer } = seed()
  const { ui, captured } = fakeUi()
  await openExplorer(explorer, ui)
  const nav = explorer.nav
  nav.ensureSelection()
  captured.component.handleInput("\r") // enter → 详情
  assert.equal(nav.state.view, "detail")

  // 触发一次 render：渲染层回报视口行数与最大滚动起点
  captured.component.render(90)
  assert.ok(nav.state.pageSize > 0, "视口行数已回报")
  const pageSize = nav.state.pageSize

  // 详情内容不足以滚动时不应越界
  const before = nav.state.detailScrollTop
  captured.component.handleInput("\x1b[6~") // PgDn
  assert.ok(nav.state.detailScrollTop >= before)
  assert.ok(nav.state.detailScrollTop <= nav.state.detailMaxScroll, "PgDn 不越界")

  // 手动放大可滚动范围后验证按页步进
  nav.setDetailMaxScroll(pageSize * 3)
  nav.state.detailScrollTop = 0
  captured.component.handleInput("\x1b[6~")
  assert.equal(nav.state.detailScrollTop, pageSize, "PgDn 前进一页")
  captured.component.handleInput("\x1b[5~")
  assert.equal(nav.state.detailScrollTop, 0, "PgUp 回退一页")
  explorer.dispose()
  closeExplorer()
})
