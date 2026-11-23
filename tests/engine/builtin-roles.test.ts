/**
 * 内置角色 workflow 与 quality-loop 组合脚本测试
 *
 * 覆盖：
 *  - 五个脚本可被 parseWorkflowScript 解析，meta.id 稳定且唯一
 *  - 四个角色各自只调一次 agent，tier 按角色缺省值路由
 *  - fixer 缺 findings 明确报错（不静默跑空）
 *  - quality-loop：直接收敛 / 一轮修复后收敛 / 轮次耗尽 / 实施升级 四条路径
 *  - quality-loop 通过注册名调用子角色，不内联复制角色 prompt
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runWorkflow } from "../../src/engine/runtime/workflow-runtime.js"
import { parseWorkflowScript } from "../../src/engine/runtime/vm.js"
import type { AgentSessionRunner } from "../../src/engine/agent/session-runner.js"
import { structuredResult } from "./helpers.js"

const REPO = path.resolve(import.meta.dirname, "../..")
const WORKFLOWS_DIR = path.join(REPO, "workflows")
const BUILTIN_IDS = ["coder", "reviewer", "judge", "fixer", "quality-loop"]

/** 分类目录下的脚本路径（roles/ 单角色，flows/ 组合） */
function workflowPath(id: string): string {
  const role = path.join(WORKFLOWS_DIR, "roles", `${id}.js`)
  return fs.existsSync(role) ? role : path.join(WORKFLOWS_DIR, "flows", `${id}.js`)
}

function readWorkflow(id: string): string {
  return fs.readFileSync(workflowPath(id), "utf-8")
}

/** 临时项目：内置 workflow 随包自动并入 registry，无需复制或注册。 */
function tmpProjectWithBuiltins(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-builtin-"))
}

/** 按调用顺序返回预设结构化结果，并记录每次调用的 model/label */
function queueRunner(results: unknown[]) {
  const calls: Array<{ label: string; model?: string; phase?: string }> = []
  const runner: AgentSessionRunner = {
    async run(_prompt, options) {
      calls.push({ label: options.label ?? "", model: options.model, phase: options.phase })
      const next = results.shift()
      if (next === undefined) throw new Error(`fake runner 调用超出预设序列（第 ${calls.length} 次，label=${options.label}）`)
      return structuredResult(next)
    },
  }
  return { runner, calls }
}

/** 角色契约替身：continue 必须带可执行 findings（fixer 不接受空清单） */
const resultOf = (status: string, summary = "ok") => ({
  status,
  summary,
  findings:
    status === "continue"
      ? [{ severity: "high", location: "src/x.ts:1", evidence: "fake", recommendation: "fake" }]
      : [],
  evidence: ["fake"],
  nextStep: "fake",
})

const tierResolver = (tier: string) => `fake/${tier}`

async function run(id: string, args: unknown, results: unknown[], cwd = REPO) {
  const { runner, calls } = queueRunner([...results])
  const result = await runWorkflow(readWorkflow(id), {
    args,
    agent: runner,
    cwd,
    resolveTier: tierResolver,
  })
  return { result, calls }
}

test("五个脚本可解析，meta.id 稳定且互不相同", () => {
  const ids = BUILTIN_IDS.map((id) => parseWorkflowScript(readWorkflow(id)).meta.id)
  assert.deepEqual(ids, BUILTIN_IDS)
  assert.equal(new Set(ids).size, ids.length)
})

test("coder：一次 agent 调用，缺省 tier=fast，输出原样返回", async () => {
  const { result, calls } = await run("coder", { task: "改个 bug" }, [resultOf("completed", "改好了")])
  assert.equal(result.agentCount, 1)
  assert.equal(calls[0]!.model, "fake/fast")
  assert.equal((result.result as { summary: string }).summary, "改好了")
})

test("字符串 args：整段即 task（/coder 修复 xxx 形态）", async () => {
  const { result, calls } = await run("coder", "修复 登录 超时", [resultOf("completed", "ok")])
  assert.equal(result.agentCount, 1)
  assert.equal(calls[0]!.model, "fake/fast")
  assert.equal((result.result as { status: string }).status, "completed")
})

test("字符串 args：quality-loop 也接受整段指令，档位走缺省", async () => {
  const cwd = tmpProjectWithBuiltins()
  const { result, calls } = await run(
    "quality-loop",
    "做点事",
    [resultOf("completed"), resultOf("completed"), resultOf("converged")],
    cwd,
  )
  assert.equal((result.result as { status: string }).status, "converged")
  assert.deepEqual(calls.map((c) => c.model), ["fake/fast", "fake/big", "fake/big"])
})

test("reviewer：一次 agent 调用，缺省 tier=big，空 findings 合法", async () => {
  const { result, calls } = await run("reviewer", { task: "评审改动" }, [resultOf("completed", "无问题")])
  assert.equal(result.agentCount, 1)
  assert.equal(calls[0]!.model, "fake/big")
  assert.deepEqual((result.result as { findings: unknown[] }).findings, [])
})

test("judge：一次 agent 调用，三态原样透传", async () => {
  for (const status of ["converged", "continue", "escalate"]) {
    const { result } = await run("judge", { task: "裁决", findings: [] }, [resultOf(status)])
    assert.equal((result.result as { status: string }).status, status)
    assert.equal(result.agentCount, 1)
  }
})

test("fixer：一次 agent 调用，缺省 tier=fast", async () => {
  const findings = [{ severity: "high", location: "a.ts:1", evidence: "e", recommendation: "r" }]
  const { result, calls } = await run("fixer", { task: "修复", findings }, [resultOf("completed")])
  assert.equal(result.agentCount, 1)
  assert.equal(calls[0]!.model, "fake/fast")
})

test("fixer：缺 findings 明确报错，不跑空修复", async () => {
  await assert.rejects(run("fixer", { task: "修复" }, []), /fixer 需要 args\.findings/)
})

test("角色脚本：缺 task 明确报错", async () => {
  await assert.rejects(run("coder", {}, []), /coder 需要 args\.task/)
  await assert.rejects(run("reviewer", {}, []), /reviewer 需要 args\.task/)
  await assert.rejects(run("judge", {}, []), /judge 需要 args\.task/)
})

test("quality-loop：judge 直接 converged 时不调用 fixer", async () => {
  const cwd = tmpProjectWithBuiltins()
  const { result, calls } = await run(
    "quality-loop",
    { task: "做点事" },
    [resultOf("completed"), resultOf("completed", "评审通过"), resultOf("converged", "收敛")],
    cwd,
  )
  assert.equal(result.agentCount, 3)
  assert.equal((result.result as { status: string }).status, "converged")
  assert.equal((result.result as { roundsCompleted: number }).roundsCompleted, 1)
  assert.deepEqual(calls.map((c) => c.model), ["fake/fast", "fake/big", "fake/big"], "各角色缺省 tier")
  assert.equal(result.workflows.some((w) => w.workflowId === "fixer"), false, "不得调用 fixer")
})

test("quality-loop：judge continue 走一轮修复后收敛", async () => {
  const cwd = tmpProjectWithBuiltins()
  const { result } = await run(
    "quality-loop",
    { task: "做点事" },
    [
      resultOf("completed"),
      resultOf("completed"),
      resultOf("continue", "有问题"),
      resultOf("completed", "修好了"),
      resultOf("completed"),
      resultOf("converged", "收敛"),
    ],
    cwd,
  )
  const out = result.result as { status: string; roundsCompleted: number; stages: { repairs: unknown[] } }
  assert.equal(out.status, "converged")
  assert.equal(out.roundsCompleted, 2)
  assert.equal(out.stages.repairs.length, 1)
  assert.equal(result.agentCount, 6)
  assert.equal(result.workflows.filter((w) => w.workflowId === "fixer").length, 1)
})

test("quality-loop：轮次耗尽返回 continue，不无限循环", async () => {
  const cwd = tmpProjectWithBuiltins()
  const { result } = await run(
    "quality-loop",
    { task: "做点事" },
    [
      resultOf("completed"),
      resultOf("completed"),
      resultOf("continue", "还有问题"),
      resultOf("completed"),
      resultOf("completed"),
      resultOf("continue", "还有问题"),
    ],
    cwd,
  )
  const out = result.result as { status: string; roundsCompleted: number }
  assert.equal(out.status, "continue")
  assert.equal(out.roundsCompleted, 2)
  assert.equal(result.agentCount, 6, "1 轮修复后复审复裁即停")
})

test("quality-loop：实施升级立即返回，不进入评审", async () => {
  const cwd = tmpProjectWithBuiltins()
  const { result } = await run("quality-loop", { task: "做点事" }, [resultOf("escalate", "缺授权")], cwd)
  const out = result.result as { status: string; roundsCompleted: number; stages: { reviews: unknown[] } }
  assert.equal(out.status, "escalate")
  assert.equal(out.roundsCompleted, 0)
  assert.equal((out.stages.reviews as unknown[]).length, 0)
  assert.equal(result.agentCount, 1)
})

test("quality-loop：各角色 tier 可单独覆盖", async () => {
  const cwd = tmpProjectWithBuiltins()
  const { result, calls } = await run(
    "quality-loop",
    { task: "做点事", coderTier: "big", reviewerTier: "ultra", judgeTier: "ultra", fixerTier: "big" },
    [
      resultOf("completed"),
      resultOf("completed"),
      resultOf("continue"),
      resultOf("completed"),
      resultOf("completed"),
      resultOf("converged"),
    ],
    cwd,
  )
  assert.equal(result.agentCount, 6)
  assert.deepEqual(calls.map((c) => c.model), [
    "fake/big",
    "fake/ultra",
    "fake/ultra",
    "fake/big",
    "fake/ultra",
    "fake/ultra",
  ])
})
