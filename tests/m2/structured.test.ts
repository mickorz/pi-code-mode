// validateStructured 纯函数测试（JSON 解析 + typebox schema 校验）
import { test } from "node:test"
import assert from "node:assert/strict"
import { Type } from "typebox"
import { validateStructured } from "../../src/adapter/structured.js"

const SCHEMA = Type.Object({ ok: Type.Boolean(), n: Type.Number() })

test("校验: 围栏 JSON 解析 + schema 通过", () => {
  const r = validateStructured('```json\n{"ok": true, "n": 3}\n```', SCHEMA)
  assert.equal(r.ok, true)
  assert.deepEqual(r.value, { ok: true, n: 3 })
})

test("校验: 纯 JSON 无围栏", () => {
  const r = validateStructured('{"ok": false, "n": 0}', SCHEMA)
  assert.equal(r.ok, true)
})

test("校验: 非 JSON 文本 -> 错误清单含修复指引", () => {
  const r = validateStructured("我觉得应该是这样的：blabla", SCHEMA)
  assert.equal(r.ok, false)
  assert.ok((r.errors ?? []).some((m) => m.includes("JSON")))
})

test("校验: schema 字段类型不符 -> 错误清单", () => {
  const r = validateStructured('{"ok": "yes"}', SCHEMA)
  assert.equal(r.ok, false)
  assert.ok((r.errors ?? []).length > 0)
})

test("校验: 缺必填字段 -> 错误清单", () => {
  const r = validateStructured('{"ok": true}', SCHEMA)
  assert.equal(r.ok, false)
})

test("校验: 非法 schema 时透传解析结果（不阻塞）", () => {
  const r = validateStructured('{"x": 1}', { type: "not-a-real-type" })
  assert.equal(r.ok, true)
})
