// M2 Sandbox contract 测试（不调 LLM、不依赖 SRT 运行时；纯配置与平台策略）
// 覆盖：配置安全基线（写入边界/凭据禁读/网络默认拒绝/环境变量黑名单/绝对路径）+
//       Windows 明确拒绝 + 平台判定 + 空命令/预取消 fail-closed
// 用法: npx tsx --test sandbox-m2.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"

import {
  buildSandboxConfig,
  credentialDenyReadPaths,
  normalizeAbsolute,
  sandboxPlatformSupported,
  DENIED_ENV_VARS,
  CREDENTIAL_DIRS,
  SrtCommandExecutor,
} from "../../packages/execution/src/index.js"

test("M2 config: 写入边界 = 仅工作区（显式允许 + literal + 绝对路径）", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pcm-m2cfg-"))
  try {
    const cfg = buildSandboxConfig({ workspace: root }) as unknown as {
      filesystem: { allowWrite: Array<{ path: string; literal?: boolean }>; denyRead: Array<{ path: string; literal?: boolean }> }
    }
    assert.equal(cfg.filesystem.allowWrite.length, 1, "写入边界只允许工作区，不给系统路径开后门")
    const written = cfg.filesystem.allowWrite[0]
    assert.equal(written.literal, true, "literal 避免 glob 语义在 macOS/Linux 不一致")
    assert.ok(path.isAbsolute(written.path), `必须是绝对路径，实际 ${written.path}`)
    assert.ok(!written.path.includes("*"), "不允许通配")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("M2 config: 凭据目录全部 denyRead（SRT 默认允许读取，不显式 deny 等于全可读）", () => {
  const cfg = buildSandboxConfig({ workspace: process.cwd() }) as unknown as {
    filesystem: { denyRead: Array<{ path: string; literal?: boolean }> }
  }
  const denied = cfg.filesystem.denyRead.map((e) => e.path)
  for (const dir of CREDENTIAL_DIRS) {
    const expected = path.join(os.homedir(), dir)
    assert.ok(denied.includes(expected), `凭据目录未登记 denyRead: ${dir}`)
  }
  assert.deepEqual(credentialDenyReadPaths().length, CREDENTIAL_DIRS.length)
  assert.ok(cfg.filesystem.denyRead.every((e) => e.literal === true), "凭据路径用 literal，防 glob 误匹配")
  // 关键凭据必须在内
  for (const must of [".ssh", ".aws", ".gnupg"]) {
    assert.ok(denied.some((p) => p.includes(must)), `${must} 必须在 denyRead`)
  }
})

test("M2 config: 网络默认严格拒绝（空 allowlist + strictAllowlist）", () => {
  const cfg = buildSandboxConfig({ workspace: process.cwd() }) as unknown as {
    network: { allowedDomains: string[]; strictAllowlist?: boolean }
  }
  assert.deepEqual(cfg.network.allowedDomains, [], "缺省不放行任何域名")
  assert.equal(cfg.network.strictAllowlist, true, "严格白名单：未列出的域名一律拒绝")
  // 显式白名单可放行
  const withDomains = buildSandboxConfig({ workspace: process.cwd(), allowedDomains: ["registry.npmjs.org"] }) as unknown as {
    network: { allowedDomains: string[] }
  }
  assert.deepEqual(withDomains.network.allowedDomains, ["registry.npmjs.org"])
})

test("M2 config: 环境变量黑名单覆盖注入面（含评审提到的两个）", () => {
  const cfg = buildSandboxConfig({ workspace: process.cwd() }) as unknown as {
    credentials: { envVars: Array<{ name: string; mode: string }> }
  }
  const names = cfg.credentials.envVars.map((e) => e.name)
  for (const must of ["JAVA_TOOL_OPTIONS", "GIT_CONFIG_COUNT", "LD_PRELOAD", "NODE_OPTIONS"]) {
    assert.ok(names.includes(must), `${must} 必须在拒绝清单`)
  }
  assert.ok(cfg.credentials.envVars.every((e) => e.mode === "deny"), "全部按名拒绝，不得放宽为 mask")
  assert.deepEqual([...names].sort(), [...DENIED_ENV_VARS].sort())
})

test("M2 config: 规范化路径（相对路径转绝对、消解 . / ..）", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pcm-m2path-"))
  try {
    const rel = normalizeAbsolute(".", root)
    assert.ok(path.isAbsolute(rel))
    const nested = normalizeAbsolute(path.join(root, "a", "..", "b"), root)
    assert.ok(!nested.includes(".."), `必须消解 ..，实际 ${nested}`)
    assert.ok(nested.startsWith(path.resolve(root)) || nested.startsWith(rel), `应在工作区内: ${nested}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("M2 平台: Windows 明确不支持，darwin/linux 支持", () => {
  assert.equal(sandboxPlatformSupported("win32"), false, "Windows 必须 explicit unsupported")
  assert.equal(sandboxPlatformSupported("darwin"), true)
  assert.equal(sandboxPlatformSupported("linux"), true)
  assert.equal(sandboxPlatformSupported("freebsd"), false)
})

test("M2 executor: Windows 返回 isolation_unavailable（不 spawn、不降级）", async () => {
  const executor = new SrtCommandExecutor({ platform: "win32" })
  const r = await executor.execute({ command: "echo hello", cwd: process.cwd() })
  assert.equal(r.blocked, true)
  assert.equal(r.exitCode, null)
  assert.ok(r.blockReason?.includes("isolation_unavailable"), `实际 ${r.blockReason}`)
  assert.equal(r.stdout, "", "未执行不得有任何输出")
})

test("M2 executor: 空命令与预取消 fail-closed", async () => {
  const executor = new SrtCommandExecutor({ platform: "darwin" })
  const empty = await executor.execute({ command: "   ", cwd: process.cwd() })
  assert.equal(empty.blocked, true)
  assert.equal(empty.blockReason, "empty_command")
  const aborted = await executor.execute({
    command: "echo hi",
    cwd: process.cwd(),
    signal: AbortSignal.abort(),
  })
  assert.equal(aborted.blocked, true)
  assert.equal(aborted.blockReason, "aborted_before_start")
})

test("M2 executor: 当前平台（本机 Windows）真实调用返回隔离不可用而非宿主执行", async () => {
  const executor = new SrtCommandExecutor()
  const r = await executor.execute({ command: "echo SHOULD_NOT_RUN", cwd: process.cwd() })
  if (process.platform !== "darwin" && process.platform !== "linux") {
    assert.equal(r.blocked, true)
    assert.equal(r.stdout, "", "关键：绝不能出现宿主机执行的输出")
    assert.ok(!r.stdout.includes("SHOULD_NOT_RUN"))
  } else {
    // Linux/macOS CI：此处应进入真实沙盒路径（由 M2.0 验收脚本覆盖）
    assert.ok(r.exitCode !== undefined)
  }
})
