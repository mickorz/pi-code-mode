/**
 * M4-T2 契约测试：上下文三层（Shared / Task / Evidence Reference）
 * 关键：摘要不得替代原始证据；证据覆盖率可量化
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import { LayeredContext } from "../../packages/engine/src/adaptive/context-layers.js"

test("注册共享上下文：只有摘要没有证据 → 拒绝（防摘要替代原文）", () => {
  const ctx = new LayeredContext()
  assert.throws(() => ctx.registerShared({ ref: "ctx://rules", summary: "规则摘要", evidence: [] }), /必须至少保留一条 Evidence Reference/)
})

test("共享上下文 + 任务上下文：prompt 只放引用不重复全文", () => {
  const ctx = new LayeredContext()
  ctx.registerShared({
    ref: "ctx://rules",
    summary: "麻将规则（导航用摘要）",
    sourceBytes: 50000,
    evidence: [{ ref: "file://rules.md", span: "全篇", itemCount: 128 }],
  })
  ctx.registerTask({ taskKey: "scan-0", input: { group: "结算" } })
  const prompt = ctx.renderForTask("scan-0", "ctx://rules")
  assert.match(prompt, /\[Shared Context\] ctx:\/\/rules/)
  assert.match(prompt, /原文 50000 字节，通过引用读取/)
  assert.match(prompt, /\[Evidence Reference\]/)
  assert.match(prompt, /file:\/\/rules\.md/)
  assert.match(prompt, /\[Task Context\] scan-0/)
  assert.ok(prompt.length < 2000, `prompt 应远小于原文（实际 ${prompt.length}）`)
})

test("证据覆盖率：全部保留 → coverage=1", () => {
  const ctx = new LayeredContext()
  const expected = [{ ref: "file://rules.md" }, { ref: "file://cases.json" }]
  ctx.registerShared({ ref: "ctx://rules", evidence: expected })
  const v = ctx.validate(expected)
  assert.equal(v.ok, true)
  assert.equal(v.evidenceCoverage, 1)
})

test("证据覆盖率：缺失证据 → 检出且 coverage<1", () => {
  const ctx = new LayeredContext()
  ctx.registerShared({ ref: "ctx://rules", evidence: [{ ref: "file://rules.md" }] })
  const v = ctx.validate([{ ref: "file://rules.md" }, { ref: "file://missing.json" }])
  assert.equal(v.ok, false)
  assert.equal(v.evidenceCoverage, 0.5)
  assert.ok(v.errors.some((e) => /missing\.json/.test(e)))
})

test("任务级证据：按需附加，仍计入覆盖率", () => {
  const ctx = new LayeredContext()
  ctx.registerShared({ ref: "ctx://rules", evidence: [{ ref: "file://rules.md" }] })
  ctx.registerTask({ taskKey: "t1", input: "x", evidenceRefs: [{ ref: "file://case-1.json" }] })
  const v = ctx.validate([{ ref: "file://rules.md" }, { ref: "file://case-1.json" }])
  assert.equal(v.ok, true)
  assert.match(ctx.renderForTask("t1", "ctx://rules"), /\[Task Evidence\]/)
})

test("节省量估算：48 任务共享 50KB 原文 → 显著减少重复传输", () => {
  const ctx = new LayeredContext()
  ctx.registerShared({ ref: "ctx://rules", summary: "导航摘要", evidence: [{ ref: "file://rules.md" }] })
  for (let i = 0; i < 48; i++) ctx.registerTask({ taskKey: `t${i}`, input: { i } })
  const s = ctx.estimateSavings(50000)
  assert.equal(s.inlineBytes, 50000 * 48)
  assert.ok(s.savedRatio > 0.99, `节省比 ${s.savedRatio}`)
})

test("上下文指纹：摘要变化 → 指纹变化（任务指纹 inputHash 应随之失效）", () => {
  const a = new LayeredContext()
  a.registerShared({ ref: "ctx://r", summary: "摘要 A", evidence: [{ ref: "f://1" }] })
  const b = new LayeredContext()
  b.registerShared({ ref: "ctx://r", summary: "摘要 B", evidence: [{ ref: "f://1" }] })
  assert.notEqual(a.fingerprint("ctx://r"), b.fingerprint("ctx://r"))
})

test("上下文指纹：证据增加 → 指纹变化", () => {
  const a = new LayeredContext()
  a.registerShared({ ref: "ctx://r", evidence: [{ ref: "f://1" }] })
  const b = new LayeredContext()
  b.registerShared({ ref: "ctx://r", evidence: [{ ref: "f://1" }, { ref: "f://2" }] })
  assert.notEqual(a.fingerprint("ctx://r"), b.fingerprint("ctx://r"))
})

test("未注册共享上下文：指纹稳定标记 missing（不崩溃）", () => {
  const ctx = new LayeredContext()
  assert.ok(ctx.fingerprint("ctx://nope").startsWith("sha256:"))
})
