/**
 * ExplorerController 无头渲染契约（固定面板场景，2026-11-19 实测 bug 回归锁）。
 *
 * bug：ensureTree 只在 open()/selectRun() 调用，onRuntimeEvent 对 activeRunId 未定的
 * controller 丢弃全部事件 → 固定面板（直接调 view()，不经过 open）永远 rows=0。
 * 修复：view() 自动选默认 run（在途优先）并 ensureTree（幂等，快照重建）。
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { RuntimeEventBus } from "../../packages/engine/src/events/runtime-event-bus.js"
import { RunManager } from "../../packages/manager/src/run-manager.js"
import { runWorkflow } from "../../packages/engine/src/runtime/workflow-runtime.js"
import { ExplorerController } from "../../packages/explorer/src/controller/explorer-controller.js"
import type { AgentSessionRunner } from "../../packages/engine/src/agent/session-runner.js"
import { textResult } from "../engine/helpers.js"

const echoRunner: AgentSessionRunner = {
  async run(prompt: string) {
    return textResult(`echo:${prompt}`)
  },
}

test("控制器: 未 open 过时 view() 自动选默认 run 并出树行（固定面板无头渲染）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-headless-"))
  const script = path.join(dir, "s.js")
  fs.writeFileSync(
    script,
    `export const meta = { name: "s" }\nawait agent("t1", { label: "A1" })\nawait agent("t2", { label: "A2" })\nreturn "ok"`,
    "utf-8",
  )
  const bus = new RuntimeEventBus()
  const rm = new RunManager(16, bus)
  const controller = new ExplorerController({ runManager: rm, eventBus: bus, cwd: dir })
  // 关键：不调 controller.open() —— 固定面板直接 view() 的场景
  rm.register("run-headless", { label: "headless" })

  // runWorkflow 第一参数是脚本内容（非路径）
  const scriptContent = fs.readFileSync(script, "utf-8")
  await runWorkflow(scriptContent, {
    agent: echoRunner,
    runId: "run-headless",
    cwd: dir,
    onRuntimeEvent: (e) => bus.publish(e),
  })

  const view = controller.view()
  assert.ok(view.runs.some((r) => r.runId === "run-headless"), "runs 应包含该 run")
  assert.ok(view.rows.length > 0, `未 open 也应出树行（修复前 rows=0），实得 ${view.rows.length}`)
  assert.ok(view.rows.some((n) => n.label === "A1"), "树行应包含 agent 节点")

  controller.dispose()
})
