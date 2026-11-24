// model-tiers v2 池配置解析契约（字符串向后兼容 + 数组池条目）
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadModelTiers } from "../../packages/engine/src/agent/model-tiers.js"

function writeTiers(dir: string, body: object, which: "pi" | "compat" = "pi"): void {
  const file =
    which === "pi"
      ? path.join(dir, ".pi", "workflows", "model-tiers.json")
      : path.join(dir, ".opencode-workflows", "model-tiers.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ tiers: body }))
}

test("v1 字符串写法保持兼容", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiers-v1-"))
  writeTiers(dir, { fast: "prov/a-model", big: "prov/b-model" })
  const tiers = loadModelTiers({ projectDir: dir })
  assert.equal(tiers.fast, "prov/a-model")
  assert.equal(tiers.big, "prov/b-model")
})

test("v2 数组池条目解析, 非法条目被丢弃", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiers-v2-"))
  writeTiers(dir, {
    fast: [
      { model: "prov/a", concurrency: 16 },
      { model: "prov/b", concurrency: 8 },
      { model: 123 } as any,
      null,
    ],
  })
  const tiers = loadModelTiers({ projectDir: dir })
  assert.deepEqual(Array.isArray(tiers.fast) ? tiers.fast : [], [
    { model: "prov/a", concurrency: 16 },
    { model: "prov/b", concurrency: 8 },
  ])
})

test("全非法数组条目该档丢弃; 项目覆盖全局（数组覆盖字符串）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiers-mix-"))
  writeTiers(dir, { fast: "prov/global-fast" }, "compat")
  writeTiers(dir, { fast: [{ model: "prov/project-a" }] })
  const tiers = loadModelTiers({ projectDir: dir, globalFile: path.join(dir, "none.json") })
  assert.deepEqual(Array.isArray(tiers.fast) ? tiers.fast : [], [{ model: "prov/project-a", concurrency: undefined }])
})

test("空数组档位丢弃（回退未配置语义）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiers-empty-"))
  writeTiers(dir, { fast: [{ model: "  " }] })
  const tiers = loadModelTiers({ projectDir: dir })
  assert.equal(tiers.fast, undefined)
})
