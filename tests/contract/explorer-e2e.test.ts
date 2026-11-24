/**
 * Workflow Explorer 端到端（M6，无模型；对应架构设计 §12.5 验收场景）。
 *
 * 场景：Main Workflow → Phase1(A,B 并发) → Phase2(ChildWorkflow A[AgentC,AgentD] + ChildWorkflow B[AgentE]) → Phase3(AgentF)
 *
 * 验收点：
 *   1. 运行中打开 Explorer，树正确多层展开
 *   2. 进入 Child Workflow A 选中 AgentC
 *   3. 后台 AgentE 完成 → 选中节点不改变
 *   4. 关闭 Explorer 再打开 → 选中节点与展开态保持
 *   5. Journal 详情可读（prompt/result 来自落盘文件）
 *   6. 中断后 resume：树能展示回放节点与重新执行节点
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { RuntimeEventBus } from "../../packages/engine/src/events/runtime-event-bus.js"
import { RunManager } from "../../packages/manager/src/run-manager.js"
import { runWorkflow } from "../../packages/engine/src/runtime/workflow-runtime.js"
import { JournalStore } from "../../packages/engine/src/persistence/journal.js"
import { ExplorerController } from "../../packages/explorer/src/controller/explorer-controller.js"
import type { AgentSessionRunner } from "../../packages/engine/src/agent/session-runner.js"
import { textResult } from "../engine/helpers.js"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-explorer-e2e-"))
}

function put(dir: string, rel: string, content: string): void {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, "utf-8")
}

/** 可挂起的 runner：按 prompt 关键字控制何时完成（模拟"后台 agent 还在跑"） */
function controllableRunner() {
  const pending = new Map<string, Array<() => void>>()
  const runner: AgentSessionRunner = {
    async run(prompt: string) {
      if (prompt.includes("slow")) {
        await new Promise<void>((resolve) => {
          const list = pending.get("slow") ?? []
          list.push(resolve)
          pending.set("slow", list)
        })
      }
      return textResult(`echo:${prompt}`)
    },
  }
  const releaseSlow = () => {
    for (const resolve of pending.get("slow") ?? []) resolve()
    pending.clear()
  }
  return { runner, releaseSlow }
}

test("E2E: 多层执行树 + 选中不漂移 + 关闭重开保持 + Journal 详情 + resume 回放展示", async () => {
  const dir = tmpProject()
  put(
    dir,
    "childA.js",
    `export const meta = { name: "child_a" }
await agent("task C", { label: "AgentC" })
await agent("task D", { label: "AgentD" })
return "A"`,
  )
  put(
    dir,
    "childB.js",
    `export const meta = { name: "child_b" }
await agent("task E slow", { label: "AgentE" })
return "B"`,
  )
  const script = `export const meta = { name: "main_flow", phases: [{ title: "Phase1" }] }
await parallel([
  () => agent("task A", { label: "AgentA" }),
  () => agent("task B", { label: "AgentB" }),
])
phase("Phase2")
await parallel([
  () => workflow({ scriptPath: "./childA.js", label: "ChildA" }),
  () => workflow({ scriptPath: "./childB.js", label: "ChildB" }),
])
phase("Phase3")
await agent("task F", { label: "AgentF" })
return "done"`

  // ---- 1. 运行（AgentE 先挂起） ----
  const bus = new RuntimeEventBus()
  const rm = new RunManager(16, bus)
  const journal = new JournalStore(dir, path.join(dir, "journal"))
  const { runner, releaseSlow } = controllableRunner()
  const runId = "run-e2e"
  rm.register(runId, { label: "e2e" })
  const running = runWorkflow(script, {
    agent: runner,
    runId,
    cwd: dir,
    concurrency: 4,
    onAgentJournal: (entry: any) => journal.append(runId, entry.key, entry),
    onRuntimeEvent: (e: any) => bus.publish(e),
  })

  // ---- 2. 运行中打开 Explorer ----
  const explorer = new ExplorerController({ runManager: rm, eventBus: bus, cwd: dir, journalDir: path.join(dir, "journal") })
  let renders = 0
  explorer.open(() => renders++)
  // 等 AgentA/B 完成、child 流程启动（AgentE 挂起中）
  for (let i = 0; i < 100 && !rm.getSnapshot(runId)!.agents.some((a) => a.label === "AgentC"); i++) {
    await new Promise((r) => setTimeout(r, 20))
  }
  const nav = explorer.nav!
  nav.ensureSelection()
  const rowsBefore = explorer.view().rows.map((r) => `${r.kind}:${r.label}`)
  assert.ok(rowsBefore.some((r) => r.includes("ChildA")), "Child Workflow A 出现在树中")
  assert.ok(rowsBefore.some((r) => r.includes("AgentC")), "子 workflow 的 agent 已展开可见")

  // ---- 3. 选中 ChildA 下的 AgentC，后台 AgentE 完成不改变选中 ----
  const agentC = explorer.view().rows.find((r) => r.label === "AgentC")!
  nav.select(agentC.nodeKey)
  const selectedBefore = nav.state.selectedNodeKey
  releaseSlow()
  await running
  assert.equal(nav.state.selectedNodeKey, selectedBefore, "后台节点完成不抢走选中（§9.3）")

  // ---- 4. 关闭再打开：状态保持 ----
  explorer.hide()
  explorer.open(() => renders++)
  assert.equal(explorer.nav!.state.selectedNodeKey, selectedBefore, "重开后选中节点保持")

  // ---- 5. Journal 详情可读（agentId 即 journal key） ----
  const detail = explorer.detailFor(selectedBefore)
  assert.ok(detail?.agent?.prompt?.includes("task C"), "详情读到 journal 中的 prompt")
  assert.equal(detail?.agent?.result, "echo:task C")

  // ---- 6. 多层树结构完整性 ----
  const allRows = explorer.view().rows
  const workflows = allRows.filter((r) => r.kind === "workflow").map((r) => r.scopePath.length)
  assert.equal(Math.max(...workflows), 2, "main + 两个 child（scopePath 深度 2）")
  const agents = allRows.filter((r) => r.kind === "agent").map((r) => r.label).sort()
  assert.deepEqual(agents, ["AgentA", "AgentB", "AgentC", "AgentD", "AgentE", "AgentF"])
  const phases = allRows.filter((r) => r.kind === "phase").map((r) => r.label)
  // 真实阶段（Phase1-3）+ 子 workflow 无显式阶段时的隐含分桶（▸ ChildA /）
  for (const p of ["Phase1", "Phase2", "Phase3"]) assert.ok(phases.includes(p), `阶段 ${p} 可见`)
  assert.ok(phases.some((p) => p.includes("ChildA")), "子 workflow 的 agent 不丢（隐含阶段节点兑底）")
  assert.equal(rm.getSnapshot(runId)!.status, "running", "run 仍标记在途（finish 由 tool 层调用）")
  rm.finish(runId, { status: "completed" })
  explorer.dispose()

  // ---- 7. resume：journal 回放 + 重新执行都在树里可见 ----
  const resumedBus = new RuntimeEventBus()
  const rm2 = new RunManager(16, resumedBus)
  const journal2 = new JournalStore(dir, path.join(dir, "journal"))
  // resume 用纯 fake runner（上一个 controllableRunner 的 slow 分支会永久挂起）
  const plainRunner: AgentSessionRunner = { async run(prompt: string) { return textResult(`echo:${prompt}`) } }
  const resumedOpts = {
    agent: plainRunner,
    runId,
    cwd: dir,
    concurrency: 4,
    resumeJournal: journal2.load(runId),
    // 缺省 prefix 回放策略：未变前缀全部回放（explicit 策略下需 replayable:true 才回放，本用例不涉及）
    onAgentJournal: (entry: any) => journal2.append(runId, entry.key, entry),
    onRuntimeEvent: (e: any) => resumedBus.publish(e),
  }
  rm2.register(runId, { label: "resume" })
  const explorer2 = new ExplorerController({ runManager: rm2, eventBus: resumedBus, cwd: dir, journalDir: path.join(dir, "journal") })
  explorer2.open(() => {})
  await runWorkflow(script, resumedOpts)
  const replayed = explorer2.view().rows.filter((r) => r.kind === "agent" && r.metadata?.replayed)
  assert.ok(replayed.length > 0, "resume 产生的回放节点在树中标记为 [回放]")
  assert.equal(explorer2.view().rows.filter((r) => r.kind === "agent").length, 6, "resume 后仍是 6 个 agent 节点（不重复建节点）")
  explorer2.dispose()
})
