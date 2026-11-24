// tier 配置模板自动创建契约（可发现性引导：文件存在即可见，tiers 留空零行为副作用）
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ensureModelTiersTemplate, loadModelTiers } from "../../packages/engine/src/agent/model-tiers.js"

test("模板: 不存在时创建（含 tiers 空表与 __ 说明字段），创建后 loadModelTiers 正常", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiers-tpl-"))
  const file = path.join(dir, "model-tiers.json")
  const created = ensureModelTiersTemplate(file)
  assert.equal(created, file)
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.deepEqual(parsed.tiers, {}) // 零行为副作用
  assert.ok(parsed.__说明.includes("tier"))
  const tiers = loadModelTiers({ globalFile: file })
  assert.deepEqual(tiers, {}) // 空表 = 未配置 = 回退默认模型
})

test("模板: 已存在时不覆盖用户配置（幂等）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiers-tpl2-"))
  const file = path.join(dir, "model-tiers.json")
  fs.writeFileSync(file, JSON.stringify({ tiers: { fast: "prov/a" } }))
  const created = ensureModelTiersTemplate(file)
  assert.equal(created, undefined) // 未创建
  assert.equal(loadModelTiers({ globalFile: file }).fast, "prov/a") // 用户配置原样保留
})
