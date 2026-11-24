/**
 * 规则文档一致性守卫
 *
 * 目的：让 src/engine/analyzer/rules/definitions/NN-<ID>-rule.md 与代码里的规则实现
 * 永不漂移。任何一边单独改动都会让本测试失败。
 *
 * 校验四条：
 *  1. 每条 BUILTIN_RULES 规则都有对应 definitions/NN-<ID>-rule.md（不漏文档）
 *  2. 每个 definitions/*-rule.md 都能对应到真实规则（不留死文档）
 *  3. 编号从 01 起连续、无重复
 *  4. md 的「## 检查什么」段落与代码 AnalyzerRule.description 逐字一致
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

import { BUILTIN_RULES } from "../../packages/engine/src/analyzer/rules/index.js"
import { runRules } from "../../packages/engine/src/analyzer/rule-engine.js"
import { buildReport } from "../../packages/engine/src/analyzer/report-builder.js"

const DEF_DIR = path.join(import.meta.dirname, "../../packages/engine/src/analyzer/rules/definitions")
const FILE_RE = /^(\d{2})-([A-Z]+-\d{3})-rule\.md$/

interface DocFile {
  file: string
  seq: number
  id: string
  content: string
}

function readDocs(): DocFile[] {
  return fs
    .readdirSync(DEF_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((file) => {
      const m = FILE_RE.exec(file)
      assert.ok(m, `规则文档命名不符合 NN-<RULE-ID>-rule.md：${file}`)
      return {
        file,
        seq: Number(m[1]),
        id: m[2]!,
        content: fs.readFileSync(path.join(DEF_DIR, file), "utf8"),
      }
    })
    .sort((a, b) => a.seq - b.seq)
}

/** 取「## 检查什么」标题下的第一段正文（到下一个 ## 为止，去首尾空白） */
function checkWhatSection(content: string): string | undefined {
  const m = /^## 检查什么\s*\n+([\s\S]*?)(?=\n## |\n*$)/m.exec(content)
  return m?.[1]?.trim()
}

test("每条内置规则都有对应的规则文档", () => {
  const docs = readDocs()
  const documented = new Set(docs.map((d) => d.id))
  const missing = BUILTIN_RULES.filter((r) => !documented.has(r.id)).map((r) => r.id)
  assert.deepEqual(missing, [], `以下规则缺少 definitions/NN-<ID>-rule.md：${missing.join(", ")}`)
})

test("每份规则文档都对应真实存在的规则（无死文档）", () => {
  const docs = readDocs()
  const ids = new Set(BUILTIN_RULES.map((r) => r.id))
  const orphans = docs.filter((d) => !ids.has(d.id)).map((d) => d.file)
  assert.deepEqual(orphans, [], `以下文档没有对应规则实现：${orphans.join(", ")}`)
})

test("规则文档编号从 01 起连续且无重复", () => {
  const docs = readDocs()
  const seqs = docs.map((d) => d.seq)
  const expected = Array.from({ length: docs.length }, (_, i) => i + 1)
  assert.deepEqual(seqs, expected, `编号应为 01..${String(docs.length).padStart(2, "0")} 连续，实际：${seqs.join(",")}`)
})

test("文档「检查什么」与代码 description 逐字一致", () => {
  const docs = readDocs()
  const byId = new Map(docs.map((d) => [d.id, d]))
  const mismatches: string[] = []
  for (const rule of BUILTIN_RULES) {
    const doc = byId.get(rule.id)
    if (!doc) continue // 上面用例已覆盖缺失
    const section = checkWhatSection(doc.content)
    if (section !== rule.description) {
      mismatches.push(
        `${rule.id}\n  代码: ${rule.description}\n  文档: ${section ?? "(缺「## 检查什么」段落)"}`,
      )
    }
  }
  assert.deepEqual(mismatches, [], `以下规则 description 与文档不一致：\n${mismatches.join("\n")}`)
})

test("aiOnly 规则：文档必须声明由 AI 判定，且静态层不得产出结论", () => {
  const aiOnly = BUILTIN_RULES.filter((r) => r.aiOnly)
  const docs = new Map(readDocs().map((d) => [d.id, d]))
  for (const rule of aiOnly) {
    const doc = docs.get(rule.id)
    assert.ok(doc, `aiOnly 规则 ${rule.id} 缺少文档`)
    // 必须让读者知道这条规则不看静态结论——否则会误以为「没报 = 通过」
    assert.match(
      doc.content,
      /AI 规则检查|由 AI 判定|aiOnly/i,
      `aiOnly 规则 ${rule.id} 的文档必须说明由 AI 判定`,
    )
  }
  // 静态层必须真的不产出结论（analyze 返回空）
  for (const rule of aiOnly) {
    const ctx = { source: "", ast: { nodes: [], diagnostics: [] }, graph: { edges: [], counts: {} }, deps: { serialChains: [], candidates: [], unknowns: [] } }
    assert.deepEqual(
      rule.analyze(ctx as never),
      [],
      `aiOnly 规则 ${rule.id} 的静态 analyze 必须返回空数组（否则会出现未经校验的静态结论）`,
    )
  }
})

test("ruleRuns：aiOnly 规则状态记 ai-only 而不是 pass", () => {
  const src = "const a = await agent('x')\nreturn a"
  const { ruleRuns } = runRules(src)
  const rec2 = ruleRuns.find((r) => r.id === "REC-002")
  assert.ok(rec2, "REC-002 必须出现在检查清单里")
  assert.equal(rec2.aiOnly, true)
  // report 层映射为 ai-only，绝不能是 pass
  const report = buildReport({ source: src, file: "t.js", generatedAt: "T" })
  const item = report.ruleInventory.find((r) => r.id === "REC-002")!
  assert.equal(item.status, "ai-only", "静态不判定必须显示 ai-only，不能显示通过")
})

test("每份文档都声明了元信息与关键段落", () => {
  const REQUIRED_HEADINGS = [
    "## 检查什么",
    "## 为什么是问题",
    "## 命中判定（实现口径）",
    "## 报出的证据",
    "## 建议怎么改",
    "## 已知误报与局限",
    "## 验收口径",
  ]
  const problems: string[] = []
  for (const doc of readDocs()) {
    for (const h of REQUIRED_HEADINGS) {
      if (!doc.content.includes(h)) problems.push(`${doc.file} 缺少「${h}」`)
    }
    if (!doc.content.includes("| 规则 ID |")) problems.push(`${doc.file} 缺少元信息表「| 规则 ID |」行`)
  }
  assert.deepEqual(problems, [], problems.join("\n"))
})
