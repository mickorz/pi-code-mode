// M2-W2 WorkspaceRegistry contract 测试（不调 LLM、不依赖 MXC；纯注册表与路径规范化）
// 用法: npx tsx --test workspace-registry.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  WorkspaceRegistry,
  WorkspaceRegistryError,
  canonicalKeyOf,
  isAtOrUnder,
  normalizeWorkspacePath,
} from "../../packages/execution/src/index.js"

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pcm-w2-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("W2-01 注册/查路径/幂等", async () => {
  await withTmp(async (dir) => {
    const a = path.join(dir, "game-a")
    await mkdir(a, { recursive: true })
    const reg = new WorkspaceRegistry()
    const e1 = reg.register({ workspaceId: "A", rootPath: a })
    const e2 = reg.register({ workspaceId: "A", rootPath: a })
    assert.equal(reg.getAll().length, 1, "重复登记不应产生两条")
    assert.equal(e1.key, e2.key)
    assert.equal(reg.findByPath(a)?.workspaceId, "A")
    // 嵌套子目录归到所属工作区
    assert.equal(reg.findByPath(path.join(a, "src", "x")).workspaceId, "A")
    // 未登记路径
    assert.equal(reg.findByPath(path.join(dir, "other")), undefined)
  })
})

test("W2-02/04 deny 集合包含其他工作区（含 inactive）", async () => {
  await withTmp(async (dir) => {
    const a = path.join(dir, "a")
    const b = path.join(dir, "b")
    await mkdir(a, { recursive: true })
    await mkdir(b, { recursive: true })
    const reg = new WorkspaceRegistry()
    reg.register({ workspaceId: "A", rootPath: a })
    reg.register({ workspaceId: "B", rootPath: b })
    reg.acquire("A", "run-1")
    reg.acquire("B", "run-1")
    assert.equal(reg.getIsolationPolicy("A").denyWorkspaces.length, 1)
    // B 释放（关闭）后仍在 deny 集合 —— W2-04 的核心
    reg.release("B", "run-1")
    assert.equal(reg.getAll().find((e) => e.workspaceId === "B")?.status, "inactive")
    const policy = reg.getIsolationPolicy("A")
    assert.equal(policy.denyWorkspaces.length, 1, "inactive 工作区仍必须被 deny")
  })
})

test("W2-05 引用计数：多 owner 时不提前注销", async () => {
  await withTmp(async (dir) => {
    const reg = new WorkspaceRegistry()
    reg.register({ workspaceId: "A", rootPath: dir })
    reg.acquire("A", "run-1")
    reg.acquire("A", "run-2")
    reg.release("A", "run-1")
    const entry = reg.getAll().find((e) => e.workspaceId === "A")!
    assert.equal(entry.status, "active", "仍有 owner 时不应变 inactive")
    assert.deepEqual(entry.owners, ["run-2"])
    assert.throws(() => reg.unregister("A"), (e: unknown) => e instanceof WorkspaceRegistryError && e.code === "owners_present")
    reg.release("A", "run-2")
    assert.equal(reg.getAll().find((e) => e.workspaceId === "A")?.status, "inactive")
    reg.unregister("A") // 无 owner 后可注销
    assert.equal(reg.getAll().length, 0)
  })
})

test("S1 路径规范化：大小写/尾分隔符/相对片段归一", async () => {
  await withTmp(async (dir) => {
    const a = path.join(dir, "Game-A")
    await mkdir(a, { recursive: true })
    const variants = [a, a.toUpperCase(), `${a}${path.sep}`, `${a}${path.sep}..${path.sep}Game-A`]
    const keys = new Set(variants.map((v) => normalizeWorkspacePath(v).canonicalKey))
    assert.equal(keys.size, 1, `应归一为同一比较键，实际 ${[...keys].join(" | ")}`)
    // 与大小写无关的比较键语义
    assert.equal(canonicalKeyOf("E:/Projects/A"), canonicalKeyOf("e:/projects/a"))
    // 嵌套判定
    assert.ok(isAtOrUnder(canonicalKeyOf("E:/p/a/src"), canonicalKeyOf("E:/p/a")))
    assert.ok(!isAtOrUnder(canonicalKeyOf("E:/p/ab"), canonicalKeyOf("E:/p/a")), "前缀相同但不是子目录")
  })
})

test("S1c 嵌套工作区：外层的 deny 集合包含其他工作区；子工作区不 deny 自己的祖先", async () => {
  await withTmp(async (dir) => {
    const outer = path.join(dir, "outer")
    const inner = path.join(outer, "inner")
    const other = path.join(dir, "other")
    await mkdir(inner, { recursive: true })
    await mkdir(other, { recursive: true })
    const reg = new WorkspaceRegistry()
    reg.register({ workspaceId: "OUTER", rootPath: outer })
    reg.register({ workspaceId: "INNER", rootPath: inner })
    reg.register({ workspaceId: "OTHER", rootPath: other })

    const innerPolicy = reg.getIsolationPolicy("INNER")
    const names = innerPolicy.denyWorkspaces.map((p) => path.basename(p))
    assert.ok(names.includes("other"), "应 deny 无关工作区")
    assert.ok(!names.includes("outer"), "不得 deny 自己的祖先（否则连带 deny 自己）")
    assert.equal(innerPolicy.excluded?.[0]?.reason, "ancestor_of_current")
  })
})

test("S2 fail-closed：未登记工作区抛错；非法路径抛错", () => {
  const reg = new WorkspaceRegistry()
  assert.throws(() => reg.getIsolationPolicy("nope"), (e: unknown) => e instanceof WorkspaceRegistryError && e.code === "not_registered")
  assert.throws(() => reg.register({ workspaceId: "", rootPath: "/tmp" }), /workspaceId/)
  assert.throws(() => normalizeWorkspacePath("bad\u0000path"), /非法字符/)
  assert.throws(() => reg.release("nope", "x"), (e: unknown) => e instanceof WorkspaceRegistryError)
  assert.throws(() => reg.release("A", "x"), (e: unknown) => e instanceof WorkspaceRegistryError)
})
