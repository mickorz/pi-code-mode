/**
 * 分层守卫（架构强制）：packages/* 与 apps/* 的 import 方向必须只向下。
 *
 * 层划分（数值越小越基础，上层可 import 下层，禁止反向）：
 *   L1 基础设施   utils、mcp
 *   L2 内核       engine
 *   L3 宿主适配   adapter
 *   L4 宿主服务   manager、tools、explorer
 *   L5 应用装配   api、apps/plugin
 *
 * 同层之间允许互相引用（manager ↔ tools 属同层协作，不是违规）。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "../..")

const LAYERS: Record<string, number> = {
  utils: 1,
  mcp: 1,
  engine: 2,
  adapter: 3,
  manager: 4,
  tools: 4,
  explorer: 4,
  api: 5,
}

/** 把仓库相对路径映射成层名：packages/<name>/... 或 apps/<app>/... */
function unitOf(relPath: string): string | null {
  const parts = relPath.split("/")
  if (parts[0] === "packages") return parts[1] ?? null
  if (parts[0] === "apps") return "apps"
  return null
}

function rankOf(unit: string): number {
  if (unit === "apps") return 5
  const layer = LAYERS[unit]
  assert.notEqual(layer, undefined, `分层表缺少 ${unit}，请在 LAYERS 中登记`)
  return layer as number
}

function collectTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue
      collectTs(rel, out)
    } else if (rel.endsWith(".ts")) out.push(rel)
  }
  return out
}

// 覆盖三种写法：from "..."、副作用 import "..."、动态 import("...")
const SPEC = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g

test("分层守卫：packages/apps 的跨单元 import 只能指向同层或更低层", () => {
  const files = [...collectTs("packages"), ...collectTs("apps")]
  assert.ok(files.length > 50, "应扫描到源码文件（路径或分层表配置错误）")

  const violations: string[] = []
  for (const file of files) {
    const fromUnit = unitOf(file)
    if (!fromUnit) continue
    const fromRank = rankOf(fromUnit)
    const src = fs.readFileSync(path.join(ROOT, file), "utf8")
    for (const match of src.matchAll(SPEC)) {
      const spec = match[1]
      if (!spec || !spec.startsWith(".")) continue
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))
      const toUnit = unitOf(target)
      if (!toUnit || toUnit === fromUnit) continue
      const toRank = rankOf(toUnit)
      if (toRank > fromRank) {
        violations.push(`${file} -> ${toUnit}(L${toRank})：L${fromRank} 禁止 import 上层 ${spec}`)
      }
    }
  }
  assert.deepEqual(violations, [], `发现 ${violations.length} 处分层违规:\n${violations.join("\n")}`)
})

test("分层守卫：每个 packages/* 目录都在分层表中登记", () => {
  const dirs = fs
    .readdirSync(path.join(ROOT, "packages"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  const missing = dirs.filter((d) => LAYERS[d] === undefined)
  assert.deepEqual(missing, [], `新增包未登记层级: ${missing.join(", ")}（在本文件 LAYERS 补一行）`)
})
