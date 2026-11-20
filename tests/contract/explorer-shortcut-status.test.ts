/**
 * A1/A2 回归测试：全局快捷键 toggle 语义 + 常驻状态行文本。
 *
 * 断言：
 *  - toggle：未打开 -> 打开；已打开 -> 关闭（同一时刻只有一个面板）
 *  - 关闭后 overlay 视图 hide、Controller 状态保留（选中节点不丢）
 *  - 状态行：无在途 run 返回 undefined；有在途含 run 名与进度；多 run 截断 + 计数
 *  - 状态行安装后随 run 事件更新，卸载后清除且退订
 */

import test from "node:test"
import assert from "node:assert/strict"
import { RuntimeEventBus } from "../../src/engine/events/runtime-event-bus.js"
import { RunManager } from "../../src/manager/run-manager.js"
import { ExplorerController } from "../../src/explorer/controller/explorer-controller.js"
import { toggleExplorer, isExplorerOpen, closeExplorer } from "../../extensions/explorer/index.js"
import { buildStatusText, installExplorerStatusLine, EXPLORER_STATUS_KEY } from "../../extensions/explorer/status-line.js"

/** fake 宿主 ui：记录 custom 调用，暴露 component 与 done，模拟 setStatus */
function fakeUi() {
  const state: { customCalls: number; component?: any; options?: any; done?: () => void; status: Record<string, string | undefined> } = {
    customCalls: 0,
    status: {},
  }
  const ui = {
    notify: () => {},
    setStatus: (key: string, text: string | undefined) => {
      state.status[key] = text
    },
    // 真实宿主语义：custom() 的 promise 在用户关闭面板（done）时才 resolve
    custom: (factory: any, options: any) =>
      new Promise<void>((resolve) => {
        state.customCalls++
        state.options = options
        state.component = factory({ requestRender: () => {}, terminal: { rows: 30 } }, {}, {}, () => {
          state.component?.dispose?.()
          resolve()
        })
      }),
  }
  return { ui, state }
}

function seededExplorer() {
  const bus = new RuntimeEventBus()
  const rm = new RunManager(4, bus)
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, journalDir: "/tmp/none" })
  rm.register("run-a", { label: "需求分析" })
  bus.publish({
    runId: "run-a",
    type: "workflow.started",
    scopePath: ["root"],
    payload: { name: "root_flow", label: "root_flow", scopePath: ["root"], startedAt: 1, status: "running" },
  })
  bus.publish({
    runId: "run-a",
    type: "agent.started",
    scopePath: ["root"],
    payload: { id: "run-a:0", label: "A1", status: "ok", workflowScopePath: ["root"] },
  })
  bus.publish({
    runId: "run-a",
    type: "agent.started",
    scopePath: ["root"],
    payload: { id: "run-a:1", label: "A2", status: "running", workflowScopePath: ["root"] },
  })
  return { bus, rm, explorer }
}

test("A1: ctrl+b toggle 语义——未打开则打开，已打开则关闭", async () => {
  const { explorer } = seededExplorer()
  const { ui, state } = fakeUi()

  assert.equal(isExplorerOpen(), false)
  assert.equal(await toggleExplorer(explorer, ui), "opened")
  await new Promise((r) => setTimeout(r, 5)) // 让 openExplorer 的 async 部分跑到 custom
  assert.equal(state.customCalls, 1, "首次 toggle 打开 overlay")
  assert.equal(isExplorerOpen(), true)
  assert.equal(explorer.isVisible, true)

  // 再按一次：关闭（不新增 overlay 实例）
  assert.equal(await toggleExplorer(explorer, ui), "closed")
  assert.equal(state.customCalls, 1, "再次 toggle 不重复打开")
  assert.equal(isExplorerOpen(), false)
  assert.equal(explorer.isVisible, false, "视图已隐藏")

  // 第三次：重新打开，Controller 状态仍在
  assert.equal(await toggleExplorer(explorer, ui), "opened")
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(state.customCalls, 2)
  assert.ok(explorer.nav.selectedNode, "重开后仍有选中节点")
  explorer.dispose()
  closeExplorer()
})

test("A1: 无 UI 宿主时 toggle 返回 unavailable 而不是抛错", async () => {
  const { explorer } = seededExplorer()
  assert.equal(await toggleExplorer(explorer, {} as any), "unavailable")
  assert.equal(await toggleExplorer(explorer, undefined as any), "unavailable")
  explorer.dispose()
})

test("A2: 状态行文本——无在途返回 undefined，有在途含名称与进度", () => {
  const { rm } = seededExplorer()
  assert.match(buildStatusText(rm)!, /workflow 需求分析 1\/2 · 1 running/)

  rm.finish("run-a", { status: "completed" })
  assert.equal(buildStatusText(rm), undefined, "全部终态后状态行清空")
})

test("A2: 多个在途 run 按上限截断并给出剩余计数", () => {
  const rm = new RunManager(8)
  for (const id of ["r1", "r2", "r3"]) rm.register(id, { label: id })
  const text = buildStatusText(rm, { maxRuns: 2 })!
  assert.ok(text.includes("r1") && text.includes("r2"))
  assert.ok(!text.includes("r3"), "超出上限的 run 不展开")
  assert.ok(text.includes("(+1)"), "剩余计数可见")
})

test("A2: 状态行随 run 事件更新，卸载后清除并退订", async () => {
  const { bus, rm } = seededExplorer()
  const { ui, state } = fakeUi()
  const dispose = installExplorerStatusLine(rm, ui)

  assert.match(state.status[EXPLORER_STATUS_KEY]!, /需求分析/)

  // 新 run 启动 -> lifecycle 事件即时刷新
  rm.register("run-b", { label: "第二个" })
  await new Promise((r) => setTimeout(r, 10))
  assert.match(state.status[EXPLORER_STATUS_KEY]!, /第二个/)

  // 全部结束 -> 状态清空（undefined）
  rm.finish("run-a", { status: "completed" })
  rm.finish("run-b", { status: "completed" })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(state.status[EXPLORER_STATUS_KEY], undefined)

  dispose()
  // 卸载后再注册 run，不应再更新状态行
  rm.register("run-c", { label: "第三个" })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(state.status[EXPLORER_STATUS_KEY], undefined, "卸载后不再写入")
  void bus
})

test("A1: 快捷键与状态行在 extension 装配期真实注册（ctrl+b + session 钩子）", async () => {
  const { default: extension } = await import("../../extensions/pi-code-mode.js")
  const shortcuts: Array<{ key: string; description?: string }> = []
  const handlers = new Map<string, Array<(...a: any[]) => any>>()
  const commands: string[] = []
  const pi = {
    registerShortcut: (key: string, opts: any) => shortcuts.push({ key, description: opts?.description }),
    registerCommand: (name: string) => commands.push(name),
    registerTool: () => {},
    on: (event: string, handler: any) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    sendUserMessage: async () => {},
  } as any

  extension(pi)

  const ctrlB = shortcuts.find((s) => s.key === "ctrl+b")
  assert.ok(ctrlB, "ctrl+b 已注册")
  assert.match(ctrlB!.description ?? "", /Explorer/)
  assert.ok(commands.includes("explorer") && commands.includes("workflows"), "斜杠命令仍在（A3：命令入口不删）")
  assert.ok((handlers.get("session_start") ?? []).length > 0, "session_start 钩子已接（状态行安装点）")
  assert.ok((handlers.get("session_shutdown") ?? []).length > 0, "session_shutdown 钩子已接（状态行卸载点）")
})

test("A1: overlay 打开时 Ctrl+B 字节在组件内部直接关闭（全局快捷键此时不派发）", async () => {
  const { explorer } = seededExplorer()
  const { ui, state } = fakeUi()
  assert.equal(await toggleExplorer(explorer, ui), "opened")
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(isExplorerOpen(), true)

  // 宿主 showOverlay 抢焦点后，editor 的 onExtensionShortcut 不再收到输入，
  // 所以关闭必须由组件自己拦 Ctrl+B（0x02）
  state.component.handleInput("")
  await new Promise((r) => setTimeout(r, 5))

  assert.equal(isExplorerOpen(), false, "面板已关闭")
  assert.equal(explorer.isVisible, false, "视图已隐藏")
  // 关闭后仍可再用同一按键重新打开
  assert.equal(await toggleExplorer(explorer, ui), "opened")
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(state.customCalls, 2, "重新打开生成新 overlay")
  explorer.dispose()
  closeExplorer()
})

test("A1: 普通字符不会误关面板（只有 0x02 是 ctrl+b）", async () => {
  const { explorer } = seededExplorer()
  const { ui, state } = fakeUi()
  await toggleExplorer(explorer, ui)
  await new Promise((r) => setTimeout(r, 5))
  state.component.handleInput("b")
  assert.equal(isExplorerOpen(), true, "单独字符 b 不关闭面板")
  state.component.handleInput("") // ctrl+c，未绑定 -> 也不关
  assert.equal(isExplorerOpen(), true)
  explorer.dispose()
  closeExplorer()
})
