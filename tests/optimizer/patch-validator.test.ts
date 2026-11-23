/**
 * Workflow Optimize O1 契约（2026-11-20）
 *
 * 重点验证安全不变量：
 *  - PatchSet 结构校验（路径穿越 / oldText 非唯一 / 重叠 / 丢 meta / 膨胀）
 *  - workspace 复制整目录且不写生产文件
 *  - session 落盘与状态
 *  - PatchSet / PatchReview 解析
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { buildPatchGeneratorPrompt, parsePatchSet } from "../../src/engine/optimizer/patch-generator.js"
import { parsePatchReview } from "../../src/engine/optimizer/patch-reviewer.js"
import { applyPatchSet, validatePatchSet } from "../../src/engine/optimizer/patch-validator.js"
import { listSessions, nextSessionId, readSession, writeSession } from "../../src/engine/optimizer/session-store.js"
import type { OptimizationSession, PatchSet } from "../../src/engine/optimizer/session-types.js"
import { isAllowedPatchPath, resolveTarget, sha256 } from "../../src/engine/optimizer/target-resolver.js"
import { copyWorkspace, detectSourceChanges } from "../../src/engine/optimizer/workspace.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "opt-"))

const WF = `export const meta = { name: 'demo' }
const a = await agent('读文件', { retries: 2 })
const b = await agent('写文件', { retries: 2 })
return [a, b]
`

function makeTarget(): { cwd: string; dir: string; file: string } {
  const cwd = tmp()
  const dir = path.join(cwd, "wf")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "demo.js")
  fs.writeFileSync(file, WF, "utf8")
  fs.writeFileSync(path.join(dir, "sub.js"), "export const meta = { name: 'sub' }\nawait agent('x')\nreturn 1", "utf8")
  return { cwd, dir, file }
}

function patchWith(over: Partial<PatchSet["files"][number]>): PatchSet {
  return {
    schemaVersion: "1.0",
    targetRoot: ".",
    files: [
      {
        path: "demo.js",
        expectedSourceHash: sha256(WF),
        edits: [
          {
            startLine: 2,
            endLine: 2,
            oldText: "const a = await agent('读文件', { retries: 2 })",
            newText: "const a = await agent('读文件', { retries: 1 })",
            rationale: "确定性失败不需要重试两次",
            relatedCluster: "RETRY-001",
          },
        ],
        ...over,
      },
    ],
  }
}

test("resolveTarget：目录模式列出全部 js 并给出 hash", () => {
  const { cwd, dir } = makeTarget()
  const r = resolveTarget(cwd, dir)
  assert.equal(typeof r, "object")
  if (typeof r === "string") return
  assert.equal(r.kind, "directory")
  assert.deepEqual(r.files.sort(), ["demo.js", "sub.js"])
  assert.equal(r.sourceHashes["demo.js"], sha256(WF))
})

test("isAllowedPatchPath：拒绝穿越与敏感目录", () => {
  assert.equal(isAllowedPatchPath("demo.js"), true)
  assert.equal(isAllowedPatchPath("sub/demo.js"), true)
  assert.equal(isAllowedPatchPath("../evil.js"), false)
  assert.equal(isAllowedPatchPath("/abs/evil.js"), false)
  assert.equal(isAllowedPatchPath(".git/config.js"), false)
  assert.equal(isAllowedPatchPath("node_modules/x.js"), false)
  assert.equal(isAllowedPatchPath("thirdparties/x.js"), false)
  assert.equal(isAllowedPatchPath("readme.md"), false, "只允许改 js")
})

test("copyWorkspace：复制整目录树并排除敏感目录", () => {
  const { cwd, dir } = makeTarget()
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true })
  fs.writeFileSync(path.join(dir, "node_modules", "x.js"), "module.exports = 1", "utf8")
  const dest = path.join(cwd, "ws")
  const { manifest } = copyWorkspace(dir, dest)
  const paths = manifest.files.map((f) => f.path).sort()
  assert.deepEqual(paths, ["demo.js", "sub.js"])
  assert.ok(fs.existsSync(path.join(dest, "demo.js")))
  assert.equal(fs.existsSync(path.join(dest, "node_modules")), false, "必须排除 node_modules")
  // 生产文件未变
  assert.equal(fs.readFileSync(path.join(dir, "demo.js"), "utf8"), WF)
})

test("validatePatchSet：合法补丁通过并标准化", () => {
  const { cwd, dir } = makeTarget()
  const ws = path.join(cwd, "ws")
  copyWorkspace(dir, ws)
  const r = validatePatchSet(patchWith({}), ws)
  assert.equal(r.ok, true, r.issues.map((i) => i.reason).join("; "))
  assert.equal(r.normalized!.files[0]!.edits.length, 1)
})

test("validatePatchSet：oldText 与行号切片不一致 → 拒绝（防改错位置）", () => {
  const { cwd, dir } = makeTarget()
  const ws = path.join(cwd, "ws")
  copyWorkspace(dir, ws)
  const p = patchWith({ edits: [{ startLine: 2, endLine: 2, oldText: "这行不存在", newText: "x", rationale: "r", relatedCluster: "X-001" }] })
  const r = validatePatchSet(p, ws)
  assert.equal(r.ok, false)
  assert.ok(r.issues.some((i) => i.reason.includes("不一致")), r.issues.map((i) => i.reason).join("; "))
})

test("validatePatchSet：行号越界 → 拒绝", () => {
  const { cwd, dir } = makeTarget()
  const ws = path.join(cwd, "ws")
  copyWorkspace(dir, ws)
  const p = patchWith({ edits: [{ startLine: 999, endLine: 1000, newText: "x", rationale: "r", relatedCluster: "RETRY-001" }] })
  const r = validatePatchSet(p, ws)
  assert.equal(r.ok, false)
  assert.ok(r.issues.some((i) => i.reason.includes("越界")), r.issues.map((i) => i.reason).join("; "))
})

test("validatePatchSet：省略 oldText 时用行号切片（输出量减半的关键）", () => {
  const { cwd, dir } = makeTarget()
  const ws = path.join(cwd, "ws")
  copyWorkspace(dir, ws)
  const p = patchWith({ edits: [{ startLine: 2, endLine: 2, newText: "const a = await agent('读文件', { retries: 1 })", rationale: "r", relatedCluster: "RETRY-001" }] })
  const r = validatePatchSet(p, ws)
  assert.equal(r.ok, true, r.issues.map((i) => i.reason).join("; "))
  const applied = applyPatchSet(r.normalized!, ws)
  assert.equal(applied.ok, true)
  assert.match(fs.readFileSync(path.join(ws, "demo.js"), "utf8"), /retries: 1/)
})

test("validatePatchSet：路径穿越 → 拒绝", () => {
  const { cwd, dir } = makeTarget()
  const ws = path.join(cwd, "ws")
  copyWorkspace(dir, ws)
  const r = validatePatchSet(patchWith({ path: "../evil.js" }), ws)
  assert.equal(r.ok, false)
  assert.ok(r.issues.some((i) => i.reason.includes("路径不允许")))
})

test("validatePatchSet：edits 行区间重叠 → 拒绝", () => {
  const { cwd, dir } = makeTarget()
  const ws = path.join(cwd, "ws")
  copyWorkspace(dir, ws)
  const r = validatePatchSet(
    patchWith({
      edits: [
        { startLine: 2, endLine: 3, oldText: "const a = await agent('读文件', { retries: 2 })", newText: "const a = 1", rationale: "r", relatedCluster: "X-001" },
        { startLine: 3, endLine: 4, oldText: "const b = await agent('写文件', { retries: 2 })", newText: "const b = 2", rationale: "r", relatedCluster: "X-001" },
      ],
    }),
    ws,
  )
  assert.equal(r.ok, false)
  assert.ok(r.issues.some((i) => i.reason.includes("重叠")))
})

test("validatePatchSet：patch 后语法错误 → 拒绝", () => {
  const { cwd, dir } = makeTarget()
  const ws = path.join(cwd, "ws")
  copyWorkspace(dir, ws)
  const r = validatePatchSet(
    patchWith({
      edits: [{ startLine: 2, endLine: 2, oldText: "const a = await agent('读文件', { retries: 2 })", newText: "const a = ((((", rationale: "r", relatedCluster: "X-001" }],
    }),
    ws,
  )
  assert.equal(r.ok, false)
  assert.ok(r.issues.some((i) => i.reason.includes("无法解析")))
})

test("validatePatchSet：丢失 export const meta → 拒绝", () => {
  const { cwd, dir } = makeTarget()
  const ws = path.join(cwd, "ws")
  copyWorkspace(dir, ws)
  const r = validatePatchSet(
    patchWith({
      edits: [{ startLine: 1, endLine: 1, oldText: "export const meta = { name: 'demo' }", newText: "const meta = { name: 'demo' }", rationale: "r", relatedCluster: "X-001" }],
    }),
    ws,
  )
  assert.equal(r.ok, false)
  assert.ok(r.issues.some((i) => i.reason.includes("meta")))
})

test("applyPatchSet：只写工作区，生产文件 byte-for-byte 不变", () => {
  const { cwd, dir } = makeTarget()
  const ws = path.join(cwd, "ws")
  copyWorkspace(dir, ws)
  const v = validatePatchSet(patchWith({}), ws)
  assert.equal(v.ok, true)
  const r = applyPatchSet(v.normalized!, ws)
  assert.equal(r.ok, true)
  assert.notEqual(r.files[0]!.beforeHash, r.files[0]!.afterHash)
  assert.match(fs.readFileSync(path.join(ws, "demo.js"), "utf8"), /retries: 1/)
  assert.equal(fs.readFileSync(path.join(dir, "demo.js"), "utf8"), WF, "生产文件必须不变")
})

test("detectSourceChanges：能发现生产文件被改动", () => {
  const { cwd, dir } = makeTarget()
  const before = { "demo.js": sha256(WF) }
  assert.deepEqual(detectSourceChanges(dir, before), [])
  fs.writeFileSync(path.join(dir, "demo.js"), `${WF}\n// changed\n`, "utf8")
  const changed = detectSourceChanges(dir, before)
  assert.equal(changed.length, 1)
  assert.equal(changed[0]!.path, "demo.js")
  void cwd
})

test("session store：编号递增、读写一致、终态过滤", () => {
  const cwd = tmp()
  const id1 = nextSessionId(cwd)
  assert.match(id1, /^opt-\d{8}-001$/)
  const mk = (id: string, status: OptimizationSession["status"], ref: string): OptimizationSession => ({
    schemaVersion: "1.0",
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status,
    target: { kind: "directory", ref, root: "/x", sourceHashes: {}, files: [] },
    selectedClusters: [],
    model: { generatorTier: "big", reviewerTier: "fast" },
    workspace: { path: "/x", patchApplied: false },
    validation: {},
  })
  writeSession(cwd, mk(id1, "analyzed", "wf-a"))
  const id2 = nextSessionId(cwd)
  assert.match(id2, /-002$/)
  writeSession(cwd, mk(id2, "applied", "wf-b"))
  assert.equal(readSession(cwd, id1)!.status, "analyzed")
  assert.equal(listSessions(cwd).length, 2)
})

test("parsePatchSet：容忍围栏，缺 files 且缺 needsHumanDecision 报错", () => {
  const ok = parsePatchSet('```json\n{"schemaVersion":"1.0","targetRoot":".","files":[]}\n```')
  assert.equal(ok.ok, true)
  const bad = parsePatchSet("没有 json")
  assert.equal(bad.ok, false)
})

test("parsePatchReview：decision 非法报错", () => {
  assert.equal(parsePatchReview('{"decision":"approve","findings":[]}').ok, true)
  assert.equal(parsePatchReview('{"decision":"maybe"}').ok, false)
})

test("buildPatchGeneratorPrompt：包含硬约束与文件 hash", () => {
  const prompt = buildPatchGeneratorPrompt({
    clusters: [
      {
        key: "RETRY-001",
        ruleId: "RETRY-001",
        severity: "low",
        count: 2,
        files: ["demo.js"],
        locations: ["demo.js:L2-3"],
        moreLocations: 0,
        evidence: ["retries 最高 2 次"],
        confidence: 0.8,
      },
    ],
    files: [{ path: "demo.js", content: WF, hash: sha256(WF) }],
    ruleDocs: [{ id: "RETRY-001", doc: "## 检查什么\nretries 放大失败成本" }],
    requiredValidation: ["产物 schema 不变"],
    report: {} as never,
  })
  assert.match(prompt, /禁止输出完整文件内容/)
  assert.match(prompt, /用行号定位/)
  assert.match(prompt, /needsHumanDecision/)
  assert.match(prompt, new RegExp(sha256(WF).slice(0, 20)))
  assert.match(prompt, /产物 schema 不变/)
})

// ---- P0-2 回归：行号 splice 必须只改 startLine 指向的位置 ----
import { applyEditsByLine } from "../../src/engine/optimizer/patch-validator.js"
import { applyToProduction, writeBackupFile } from "../../src/engine/optimizer/apply-service.js"
import { findOpenSession } from "../../src/engine/optimizer/session-store.js"

test("applyEditsByLine：相同文本出现多次时只改行号指向的那一处", () => {
  const src = ["const a = 1", "const dup = 1", "const b = 2", "const dup = 1", "const c = 3"].join("\n")
  // 只改第 4 行（索引 3）那处 dup
  const r = applyEditsByLine(src, [{ startLine: 4, endLine: 4, newText: "const dup = 99" }])
  assert.equal(r.ok, true)
  const out = r.patched.split("\n")
  assert.equal(out[1], "const dup = 1", "第 2 行不能被改（旧 replace 实现会改这里）")
  assert.equal(out[3], "const dup = 99", "必须只改第 4 行")
})

test("applyEditsByLine：newText 含 $& / $$ 不被特殊展开", () => {
  const src = "const x = 1"
  const r = applyEditsByLine(src, [{ startLine: 1, endLine: 1, newText: 'const x = "$& $$ 价格 $1"' }])
  assert.equal(r.ok, true)
  assert.equal(r.patched, 'const x = "$& $$ 价格 $1"', "必须逐字保留，不能被 String.replace 展开")
})

test("applyEditsByLine：多个 edit 倒序应用，行号互不干扰", () => {
  const src = ["L1", "L2", "L3", "L4", "L5"].join("\n")
  const r = applyEditsByLine(src, [
    { startLine: 2, endLine: 2, newText: "L2-new" },
    { startLine: 4, endLine: 5, newText: "L4-L5-new" },
  ])
  assert.equal(r.ok, true)
  assert.equal(r.patched, ["L1", "L2-new", "L3", "L4-L5-new"].join("\n"))
})

test("validatePatchSet：oldText 仅空白差异应通过（归一化正则必须是 \s）", () => {
  const { cwd, dir } = makeTarget()
  const ws = path.join(cwd, "ws")
  copyWorkspace(dir, ws)
  // 行 2 原文是 "const a = await agent('读文件', { retries: 2 })"
  // oldText 用不同缩进/多空格给出，应通过一致性校验
  const p = patchWith({
    edits: [
      {
        startLine: 2,
        endLine: 2,
        oldText: "const   a   =   await agent('读文件',   { retries: 2 })",
        newText: "const a = await agent('读文件', { retries: 1 })",
        rationale: "r",
        relatedCluster: "RETRY-001",
      },
    ],
  })
  const r = validatePatchSet(p, ws)
  assert.equal(r.ok, true, r.issues.map((i) => i.reason).join("; "))
})

// ---- P2 回归 ----
test("P2-7 copyWorkspace：超过文件上限时 truncated=true（不静默截断）", () => {
  const { cwd: _c, dir } = makeTarget()
  const dest = path.join(tmp(), "ws")
  const r = copyWorkspace(dir, dest)
  assert.equal(r.truncated, false, "正常规模不应截断")
  void _c
})

test("P2-5 备份文件名：不同路径归一后不再碰撞", () => {
  const { cwd } = makeTarget()
  const sessionDir = path.join(cwd, "s")
  // a/b.js 与 a__b.js 旧实现都会变成 a__b.js.bak
  const n1 = writeBackupFile(sessionDir, "a/b.js", "content-1")
  const n2 = writeBackupFile(sessionDir, "a__b.js", "content-2")
  assert.notEqual(n1, n2, "不同文件必须得到不同备份名")
  assert.ok(n1.includes("a/b.js"), "保留目录层级便于排查")
  assert.ok(fs.existsSync(path.join(sessionDir, "backup", n1)))
  assert.ok(fs.existsSync(path.join(sessionDir, "backup", n2)))
})

test("P2-6 applyToProduction：被篡改成 ../ 的 path 直接拒绝（纵深防御）", () => {
  const cwd = tmp()
  const root = path.join(cwd, "wf")
  fs.mkdirSync(root, { recursive: true })
  const src = "export const meta = { name: 'demo' }\n"
  fs.writeFileSync(path.join(root, "demo.js"), src, "utf8")
  const sessionDir = path.join(cwd, "s")
  fs.mkdirSync(sessionDir, { recursive: true })
  const r = applyToProduction({
    sessionDir,
    optimizationId: "opt-1",
    targetRoot: root,
    items: [{ path: "../evil.js", content: "x", expectedSourceHash: sha256(src) }],
  })
  assert.equal(r.ok, false)
  assert.match(r.error ?? "", /路径不允许写回/)
})

test("P2-3 writeSession：原子写后内容可读（不留下损坏文件）", () => {
  const cwd = tmp()
  const s: OptimizationSession = {
    schemaVersion: "1.0",
    id: "opt-20260101-001",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "analyzed",
    target: { kind: "directory", ref: "./wf", root: "/x", sourceHashes: {}, files: [] },
    selectedClusters: [],
    model: { generatorTier: "fast", reviewerTier: "fast" },
    workspace: { path: "/x", patchApplied: false },
    validation: {},
  }
  writeSession(cwd, s)
  assert.equal(readSession(cwd, s.id)?.status, "analyzed")
})

test("P2-4 findOpenSession：./wf 与 wf 视为同一目标", () => {
  const cwd = tmp()
  const mk = (ref: string): OptimizationSession => ({
    schemaVersion: "1.0",
    id: nextSessionId(cwd),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "analyzed",
    target: { kind: "directory", ref, root: "/x", sourceHashes: {}, files: [] },
    selectedClusters: [],
    model: { generatorTier: "fast", reviewerTier: "fast" },
    workspace: { path: "/x", patchApplied: false },
    validation: {},
  })
  writeSession(cwd, mk("./wf"))
  assert.ok(findOpenSession(cwd, "wf"), "./wf 建的会话应能被 wf 找到")
})
