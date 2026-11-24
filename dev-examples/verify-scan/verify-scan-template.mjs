#!/usr/bin/env node
/**
 * 1-scan-template.js 的质量门 verifier
 *
 * 用法（由 /workflows optimize --verify-cmd 调用）：
 *   node verify-scan-template.mjs
 *
 * 环境变量（optimize 的 benchmark 自动注入）：
 *   PI_OPT_BEFORE_RUN  before 轮的 runDir（相对项目根）
 *   PI_OPT_AFTER_RUN   after  轮的 runDir
 *   PI_OPT_PROJECT_ROOT 项目根
 *
 * 校验三层：
 *   A. schema：scan.json 结构合法（必填字段、类型、枚举）
 *   B. 不变量：sections 覆盖全文、行号单调、stageId 连续、intro/terms 唯一
 *   C. 等价性：after 与 before 的 scan.json **逐字段一致**（忽略时间戳类字段）
 *
 * 为什么要 C：RETRY-001 这类改动语义上不该改变产物。产物不一致就说明行为变了，
 * 无论耗时是否下降都不该算「优化成功」。
 */
import fs from "node:fs"
import path from "node:path"

const EXIT_FAIL = 1
const SCAN_REL = "1-registry/runtime/state/scan.json"

const root = process.env.PI_OPT_PROJECT_ROOT || process.cwd()
const beforeRun = process.env.PI_OPT_BEFORE_RUN
const afterRun = process.env.PI_OPT_AFTER_RUN

const errors = []
const notes = []

function fail(msg) {
  errors.push(msg)
}
function load(rel, label) {
  if (!rel) {
    fail(`${label}: 缺少 runDir 环境变量（PI_OPT_${label.toUpperCase()}_RUN），无法定位产物`)
    return undefined
  }
  const file = path.resolve(root, rel, SCAN_REL)
  if (!fs.existsSync(file)) {
    fail(`${label}: 产物不存在 ${file}`)
    return undefined
  }
  try {
    return { file, data: JSON.parse(fs.readFileSync(file, "utf8")) }
  } catch (e) {
    fail(`${label}: 产物不是合法 JSON（${file}）：${String(e?.message ?? e)}`)
    return undefined
  }
}

/** A. schema 校验 */
function validateSchema(data, label) {
  if (typeof data.templatePath !== "string" || !data.templatePath) fail(`${label}: templatePath 缺失或非字符串`)
  if (!Number.isInteger(data.totalLines) || data.totalLines < 1) fail(`${label}: totalLines 非法（${data.totalLines}）`)
  if (!Array.isArray(data.sections) || data.sections.length === 0) {
    fail(`${label}: sections 为空`)
    return
  }
  for (const [i, s] of data.sections.entries()) {
    const at = `${label}: sections[${i}]`
    if (!Number.isInteger(s.no)) fail(`${at}.no 非整数`)
    if (typeof s.title !== "string") fail(`${at}.title 非字符串`)
    if (!Number.isInteger(s.fromLine) || !Number.isInteger(s.toLine)) fail(`${at} 行号非整数`)
    if (s.fromLine > s.toLine) fail(`${at} fromLine(${s.fromLine}) > toLine(${s.toLine})`)
    if (!["intro", "terms", "stage"].includes(s.kind)) fail(`${at}.kind 非法：${s.kind}`)
  }
}

/** B. 业务不变量 */
function validateInvariants(data, label) {
  const secs = data.sections
  const total = data.totalLines

  if (secs[0].fromLine !== 1) fail(`${label}: 首节 fromLine 应为 1，实际 ${secs[0].fromLine}`)
  const last = secs[secs.length - 1]
  if (last.toLine !== total) fail(`${label}: 末节 toLine 应为 totalLines(${total})，实际 ${last.toLine}`)

  // 行号单调且首尾相接（相邻只允许隔空行：next.fromLine <= prev.toLine + 2）
  for (let i = 1; i < secs.length; i++) {
    const prev = secs[i - 1]
    const cur = secs[i]
    if (cur.fromLine <= prev.fromLine) fail(`${label}: 行号未单调递增（第 ${i} 节 fromLine ${cur.fromLine} <= 上一节 ${prev.fromLine}）`)
    const gap = cur.fromLine - prev.toLine - 1
    if (gap < 0) fail(`${label}: 区间重叠（第 ${i} 节）`)
    if (gap > 2) fail(`${label}: 第 ${i} 节前有 ${gap} 行未被覆盖（max 允许 2 行空行）`)
  }

  // intro / terms 至多各一个
  const kinds = secs.map((s) => s.kind)
  if (kinds.filter((k) => k === "intro").length > 1) fail(`${label}: intro 章节多于 1 个`)
  if (kinds.filter((k) => k === "terms").length > 1) fail(`${label}: terms 章节多于 1 个`)

  // stageId 必须 ST-C01 起连续，且仅 stage 有值
  const stages = secs.filter((s) => s.kind === "stage")
  let expect = 1
  for (const s of stages) {
    const want = `ST-C${String(expect).padStart(2, "0")}`
    if (s.stageId !== want) fail(`${label}: stageId 不连续，期望 ${want} 实际 ${s.stageId ?? "(空)"}`)
    expect += 1
  }
  for (const s of secs.filter((x) => x.kind !== "stage")) {
    if (s.stageId && s.stageId !== "") notes.push(`${label}: 非 stage 章节 ${s.no} 带了 stageId=${s.stageId}（不致命）`)
  }

  // no 应从 1 连续
  for (const [i, s] of secs.entries()) {
    if (s.no !== i + 1) fail(`${label}: sections[${i}].no 应为 ${i + 1}，实际 ${s.no}`)
  }
}

/** C. 等价性：忽略可能含时间/随机量的字段后深比较 */
const VOLATILE_KEYS = new Set(["generatedAt", "scannedAt", "createdAt", "timestamp"])
function strip(v) {
  if (Array.isArray(v)) return v.map(strip)
  if (v && typeof v === "object") {
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      if (VOLATILE_KEYS.has(k)) continue
      out[k] = strip(val)
    }
    return out
  }
  return v
}
function diffPaths(a, b, prefix = "", out = []) {
  if (a === b) return out
  const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a
  const tb = b === null ? "null" : Array.isArray(b) ? "array" : typeof b
  if (ta !== tb) {
    out.push(`${prefix || "<root>"}: 类型不同 ${ta} vs ${tb}`)
    return out
  }
  if (ta === "array") {
    if (a.length !== b.length) out.push(`${prefix}: 数组长度 ${a.length} vs ${b.length}`)
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) diffPaths(a[i], b[i], `${prefix}[${i}]`, out)
    return out
  }
  if (ta === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) diffPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k, out)
    return out
  }
  out.push(`${prefix}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
  return out
}

// ---------------- 执行 ----------------
const before = load(beforeRun, "before")
const after = load(afterRun, "after")

if (before) validateSchema(before.data, `before(${beforeRun})`)
if (after) validateSchema(after.data, `after(${afterRun})`)
if (before) validateInvariants(before.data, `before(${beforeRun})`)
if (after) validateInvariants(after.data, `after(${afterRun})`)

if (before && after) {
  const d = diffPaths(strip(before.data), strip(after.data))
  if (d.length > 0) {
    fail(`after 产物与 before 不等价（${d.length} 处差异）：`)
    for (const line of d.slice(0, 20)) fail(`  - ${line}`)
  } else {
    notes.push(`产物等价：before 与 after 的 scan.json 逐字段一致（${after.data.sections.length} 个章节）`)
  }
}

// ---------------- 输出 ----------------
for (const n of notes) console.log(`[note] ${n}`)
if (errors.length > 0) {
  console.error(`[失败] ${errors.length} 项：`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(EXIT_FAIL)
}
console.log(`[通过] scan.json 结构合法、不变量成立${before && after ? "、与 before 产物等价" : ""}`)
process.exit(0)
