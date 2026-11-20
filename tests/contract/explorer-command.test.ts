/**
 * /explorer 命令装配契约（M4/M6）：无 TUI、无模型。
 *
 * 守卫点：
 *  - 命令名与描述注册到宿主
 *  - 非 TUI 模式（hasUI=false）给出降级提示而不是抛错（RPC/print/json 模式不依赖 Explorer）
 *  - 传入 runId 时定位失败只提示，不打开面板
 */

import test from "node:test"
import assert from "node:assert/strict"
import { registerExplorerCommand } from "../../extensions/commands/explorer.js"
import { RuntimeEventBus } from "../../src/engine/events/runtime-event-bus.js"
import { RunManager } from "../../src/manager/run-manager.js"
import { ExplorerController } from "../../src/explorer/controller/explorer-controller.js"

function fakePi() {
  const commands = new Map<string, any>()
  return {
    commands,
    registerCommand(name: string, opts: any) {
      commands.set(name, opts)
    },
  }
}

function makeController() {
  const bus = new RuntimeEventBus()
  const rm = new RunManager(2, bus)
  return new ExplorerController({ runManager: rm, eventBus: bus, journalDir: "/tmp/none" })
}

test("/explorer: 命令已注册且带参数说明", () => {
  const pi = fakePi()
  registerExplorerCommand(pi as any, { explorer: makeController() })
  const cmd = pi.commands.get("explorer")
  assert.ok(cmd, "explorer 命令已注册")
  assert.ok(String(cmd.description).includes("runId"), "描述提示了 runId 定位用法")
})

test("/explorer: 非 TUI 模式降级提示，不抛错", async () => {
  const pi = fakePi()
  registerExplorerCommand(pi as any, { explorer: makeController() })
  const notices: string[] = []
  await pi.commands.get("explorer").handler("", { hasUI: false, ui: { notify: (m: string) => notices.push(m) } })
  assert.equal(notices.length, 1)
  assert.ok(notices[0].includes("/workflows list"), "提示非交互模式的替代路径")
})

test("/explorer: 未知 runId 只提示，不打开 overlay", async () => {
  const pi = fakePi()
  const explorer = makeController()
  registerExplorerCommand(pi as any, { explorer })
  const notices: string[] = []
  let customCalls = 0
  const ui = {
    notify: (m: string) => notices.push(m),
    custom: async () => {
      customCalls++
    },
  }
  await pi.commands.get("explorer").handler("ghost-run", { hasUI: true, ui })
  assert.equal(customCalls, 0, "定位失败不打开面板")
  assert.ok(notices[0].includes("未找到 run"))
})
