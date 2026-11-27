// M2-W4 受控执行面 contract 测试（不调 LLM、不依赖 MXC）
// 验证四条硬约束：分类不由模型决定 / 必须显式审批 / 全程审计 / 绝不静默降级
// 用法: npx tsx --test control-plane.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  ControlPlaneExecutor,
  RoutedCommandExecutor,
  UnavailableCommandExecutor,
  type ControlPlaneAuditEvent,
  type SandboxCommandResult,
  type CommandExecutor,
} from "../../packages/execution/src/index.js"

const COCOS_RULE = { match: "cocoscli build", reason: "GUI 构建链无法在 MXC 内启动（M2-W3b）" }

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pcm-w4-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("W4-01 分类：只有 Runtime 规则命中的命令进控制面", () => {
  const cp = new ControlPlaneExecutor({ allow: [COCOS_RULE] })
  assert.ok(cp.match("cocoscli build web-mobile"))
  assert.equal(cp.match("rm -rf /"), undefined)
  assert.equal(cp.match("echo hi"), undefined)
  // 正则规则
  const cp2 = new ControlPlaneExecutor({ allow: [{ match: /^npm\s+run\s+build/, reason: "构建" }] })
  assert.ok(cp2.match("npm run build"))
  assert.equal(cp2.match("npm run test"), undefined)
})

test("W4-02 未命中白名单 → 拒绝（不执行、不降级）", async () => {
  const audits: ControlPlaneAuditEvent[] = []
  const cp = new ControlPlaneExecutor({ allow: [COCOS_RULE], onAudit: (e) => audits.push(e) })
  const r = await cp.execute({ command: "echo not-allowed", cwd: process.cwd() })
  assert.equal(r.blocked, true)
  assert.match(r.blockReason ?? "", /not_in_control_plane_allowlist/)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].decision, "denied")
})

test("W4-03 无审批回调 → 一律拒绝（headless fail-closed）", async () => {
  const audits: ControlPlaneAuditEvent[] = []
  const cp = new ControlPlaneExecutor({ allow: [COCOS_RULE], onAudit: (e) => audits.push(e) })
  const r = await cp.execute({ command: "cocoscli build web-mobile", cwd: process.cwd() })
  assert.equal(r.blocked, true)
  assert.match(r.blockReason ?? "", /no_approval_channel/)
  assert.equal(audits[0].denyReason, "no_approval_channel")
})

test("W4-04 审批拒绝 → 不执行，审计记为 denied", async () => {
  const audits: ControlPlaneAuditEvent[] = []
  const cp = new ControlPlaneExecutor({
    allow: [COCOS_RULE],
    approve: async () => false,
    onAudit: (e) => audits.push(e),
  })
  const r = await cp.execute({ command: "cocoscli build web-mobile", cwd: process.cwd() })
  assert.equal(r.blocked, true)
  assert.match(r.blockReason ?? "", /not_approved/)
  assert.equal(audits[0].decision, "denied")
})

test("W4-05 审批回调抛错 → 拒绝（fail-closed）", async () => {
  const cp = new ControlPlaneExecutor({
    allow: [COCOS_RULE],
    approve: async () => {
      throw new Error("ui unavailable")
    },
  })
  const r = await cp.execute({ command: "cocoscli build web-mobile", cwd: process.cwd() })
  assert.equal(r.blocked, true)
})

test("W4-06 审批通过 → 真实执行并审计（含耗时与退出码）", async () => {
  await withTmp(async (dir) => {
    const audits: ControlPlaneAuditEvent[] = []
    const cp = new ControlPlaneExecutor({
      allow: [{ match: "echo ", reason: "测试用" }],
      approve: async () => true,
      onAudit: (e) => audits.push(e),
    })
    const cmd = process.platform === "win32" ? "echo control-plane-ok" : "echo control-plane-ok"
    const r = await cp.execute({ command: cmd, cwd: dir, timeoutMs: 30000, runId: "run-x", executionId: "exec-x" })
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /control-plane-ok/)
    const evt = audits.at(-1)!
    assert.equal(evt.decision, "approved")
    assert.equal(evt.exitCode, 0)
    assert.equal(evt.runId, "run-x")
    assert.ok((evt.durationMs ?? -1) >= 0)
  })
})

test("W4-07 审计只记事实：不含 stdout 内容", async () => {
  await withTmp(async (dir) => {
    // 让输出内容与命令文本不同：命令读一个含秘密的文件
    await writeFile(path.join(dir, "secret.txt"), "FILE_SECRET_CONTENT_XYZ", "utf8")
    let evt: ControlPlaneAuditEvent | undefined
    const cp = new ControlPlaneExecutor({
      allow: [{ match: "type ", reason: "测试" }, { match: "cat ", reason: "测试" }],
      approve: async () => true,
      onAudit: (e) => (evt = e),
    })
    const cmd = process.platform === "win32" ? "type secret.txt" : "cat secret.txt"
    const r = await cp.execute({ command: cmd, cwd: dir, timeoutMs: 30000 })
    assert.match(r.stdout, /FILE_SECRET_CONTENT_XYZ/, "命令确实产生了含秘密的输出")
    const serialized = JSON.stringify(evt)
    assert.ok(!serialized.includes("FILE_SECRET_CONTENT_XYZ"), "审计事件不得包含命令输出内容")
    assert.ok(serialized.includes(cmd), "命令文本本身可记（事实）")
  })
})

test("W4-08 超时终止（进程树回收）", async () => {
  await withTmp(async (dir) => {
    const cmd = process.platform === "win32" ? "ping -n 30 127.0.0.1 >nul" : "sleep 30"
    const cp = new ControlPlaneExecutor({
      // 规则需匹配平台实际命令文本（命中白名单才可能进入执行）
      allow: [{ match: process.platform === "win32" ? "ping " : "sleep", reason: "测试" }],
      approve: async () => true,
    })
    const t0 = Date.now()
    const r = await cp.execute({ command: cmd, cwd: dir, timeoutMs: 1500 })
    assert.equal(r.timedOut, true)
    assert.ok(Date.now() - t0 < 30000)
  })
})

test("W4-09 路由：沙盒失败绝不自动转控制面（结构上不可能）", async () => {
  const audits: ControlPlaneAuditEvent[] = []
  const sandboxCalls: string[] = []
  const fakeSandbox: CommandExecutor = {
    async execute(req): Promise<SandboxCommandResult> {
      sandboxCalls.push(req.command)
      // 模拟沙盒执行失败（如 GUI 无法启动）
      return { exitCode: null, stdout: "", stderr: "", blocked: true, blockReason: "isolation_unavailable" }
    },
  }
  let controlPlaneCalls = 0
  const cp = new ControlPlaneExecutor({
    allow: [COCOS_RULE],
    approve: async () => {
      controlPlaneCalls++
      return true
    },
    onAudit: (e) => audits.push(e),
  })
  const routed = new RoutedCommandExecutor(fakeSandbox, cp)

  // 非控制面命令：沙盒失败 → 直接返回失败，控制面零调用
  const r = await routed.execute({ command: "echoxxx unknown-gui-tool", cwd: process.cwd() })
  assert.equal(r.blocked, true)
  assert.equal(r.blockReason, "isolation_unavailable")
  assert.equal(sandboxCalls.length, 1)
  assert.equal(controlPlaneCalls, 0, "沙盒失败不得触发控制面执行")
  assert.equal(audits.length, 0, "控制面未被调用，不应产生审计事件")

  // 控制面命令：路由提前命中，直接走控制面
  assert.equal(routed.routeOf("cocoscli build web-mobile"), "control-plane")
  assert.equal(routed.routeOf("echo hi"), "sandbox")
})

test("W4-10 默认执行器（沙盒不可用）仍为 fail-closed", async () => {
  const ex = new UnavailableCommandExecutor()
  const r = await ex.execute({ command: "cocoscli build web-mobile", cwd: process.cwd() })
  assert.equal(r.blocked, true)
  assert.equal(r.stdout, "")
})
