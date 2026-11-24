/**
 * M6-P0-3 契约测试：schedule runner 补齐 global gate / journal / plan
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { PiScheduleRunner } from "../../packages/manager/src/pi-schedule-runner.js"
import { RunManager } from "../../packages/manager/src/run-manager.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m6-sched-"))

function fakeDeps(dir: string) {
  return { client: undefined, parentSessionId: "p", directory: dir, rootSessionId: "r" }
}

/** 等待 schedule run 完成（onFinished 回调） */
function runAndWait(runner: PiScheduleRunner, deps: any, input: any, timeoutMs = 20000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("schedule run 超时")), timeoutMs)
    runner.start(deps, {
      ...input,
      onFinished: (info) => {
        clearTimeout(timer)
        resolve(info)
      },
    })
  })
}

/** 假 adapter：稳定返回文本（避免测试依赖真实模型） */
const fakeAdapter = (): any => ({
  async execute() {
    return { status: "ok", output: { type: "text", value: "fake-result" }, sessionId: "s1" }
  },
  async cancel() {},
})

test("schedule run 落 journal（此前无 journal，无法 resume/审计）", async () => {
  const dir = tmp()
  const runner = new PiScheduleRunner({
    runManager: new RunManager(4),
    cwd: dir,
    agentDir: dir,
    adapterFactory: fakeAdapter,
  })
  const script = `export const meta = { name: 'sched_journal' }
await agent('x')
return 'done'`
  const info = await runAndWait(runner, fakeDeps(dir), { script, confirm: async () => true })
  assert.equal(info.status, "completed", JSON.stringify(info.error ?? ""))
  const journalDir = path.join(dir, ".pi", "workflows", "journal")
  assert.ok(fs.existsSync(journalDir), "journal 目录应存在")
  const files = fs.readdirSync(journalDir).filter((f) => f.endsWith(".json"))
  assert.ok(files.length >= 1, `应有 journal 文件，实际 ${JSON.stringify(files)}`)
})

test("schedule run 经 global gate（并发闸可被外部观测）", async () => {
  const dir = tmp()
  const runManager = new RunManager(1)
  const runner = new PiScheduleRunner({ runManager, cwd: dir, agentDir: dir, adapterFactory: fakeAdapter })
  const script = `export const meta = { name: 'sched_gate' }
await agent('a')
return 'ok'`
  const info = await runAndWait(runner, fakeDeps(dir), { script, confirm: async () => true })
  assert.equal(info.status, "completed")
  // gate 槽应在结束后释放（active=0），可再次取用
  assert.equal(runManager.gate.activeLeases ?? 0, 0)
})
