/**
 * 一次性 codemod：把迁移后的相对 import 重写为新位置。
 * 用法：node dev-examples/arch-migration/rewrite-imports.mjs [--dry]
 */
import fs from "node:fs"
import path from "node:path"

const DRY = process.argv.includes("--dry")
const ROOT = process.cwd()
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/")

/** 旧路径（相对仓库根）→ 新路径 */
const PREFIXES = [
  ["src/engine/", "packages/engine/src/"],
  ["src/adapter/", "packages/adapter/src/"],
  ["src/manager/", "packages/manager/src/"],
  ["src/mcp/", "packages/mcp/src/"],
  ["src/tools/", "packages/tools/src/"],
  ["src/explorer/", "packages/explorer/src/"],
  ["src/utils/", "packages/utils/src/"],
  ["src/index.ts", "packages/api/src/index.ts"],
  ["extensions/", "apps/plugin/extensions/"],
]

const oldToNew = (p) => {
  for (const [from, to] of PREFIXES) if (p.startsWith(from)) return to + p.slice(from.length)
  return null
}

/** 待处理的文件：新位置上的文件 + 未移动但 import 了源码的 tests/dev-examples */
const collect = (dir, exts) => {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue
        walk(p)
      } else if (exts.some((x) => p.endsWith(x))) out.push(rel(p))
    }
  }
  walk(dir)
  return out
}

const moved = [
  ...collect(path.join(ROOT, "packages"), [".ts"]),
  ...collect(path.join(ROOT, "apps"), [".ts"]),
]
const unmoved = [
  ...collect(path.join(ROOT, "tests"), [".ts"]),
  ...collect(path.join(ROOT, "dev-examples"), [".ts"]),
]

const SPEC = /(from\s+|import\s*\(\s*|import\s+)(["'])(\.[^"']*)\2/g
let changed = 0
const report = []

const rewrite = (file, isMoved) => {
  const newPos = isMoved ? file : file
  const oldPos = isMoved ? invNew(file) : file
  const abs = path.join(ROOT, file)
  const src = fs.readFileSync(abs, "utf8")
  const out = src.replace(SPEC, (all, lead, q, spec) => {
    const clean = spec.replace(/\.js$/, "")
    const oldDir = path.posix.dirname(oldPos)
    const oldTarget = path.posix.normalize(path.posix.join(oldDir, clean))
    const newTargetNoExt = oldToNew(oldTarget.endsWith(".ts") ? oldTarget : oldTarget + ".ts")
    if (!newTargetNoExt) return all
    const newTarget = newTargetNoExt.replace(/\.ts$/, "")
    let newSpec = path.posix.relative(path.posix.dirname(newPos), newTarget)
    if (!newSpec.startsWith(".")) newSpec = "./" + newSpec
    if (spec.endsWith(".js")) newSpec += ".js"
    if (newSpec === spec) return all
    report.push(`${file}: ${spec} -> ${newSpec}`)
    return `${lead}${q}${newSpec}${q}`
  })
  if (out !== src) {
    changed++
    if (!DRY) fs.writeFileSync(abs, out)
  }
}

function invNew(p) {
  for (const [from, to] of PREFIXES) if (p.startsWith(to)) return from + p.slice(to.length)
  throw new Error(`无法反查旧路径: ${p}`)
}

moved.forEach((f) => rewrite(f, true))
unmoved.forEach((f) => rewrite(f, false))

console.log(report.join("\n"))
console.log(`\n${DRY ? "[dry] " : ""}改写文件数: ${changed}`)
