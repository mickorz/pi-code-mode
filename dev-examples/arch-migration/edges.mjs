/**
 * 一次性：统计 src/ 与 extensions/ 之间按目录聚合的依赖边。
 * 用法：node dev-examples/arch-migration/edges.mjs
 */
import fs from "node:fs"
import path from "node:path"

const roots = ["src", "extensions"]
const files = []
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (p.endsWith(".ts")) files.push(p.split(path.sep).join("/"))
  }
}
roots.forEach(walk)

const groupOf = (f) => {
  const p = f.split("/")
  if (p[0] === "extensions") return "apps"
  return p[1] ?? "root"
}

const edges = new Map()
for (const f of files) {
  const src = fs.readFileSync(f, "utf8")
  for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const abs = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]).replace(/\.js$/, ".ts"))
    const from = groupOf(f)
    const to = groupOf(abs)
    const k = `${from} -> ${to}`
    edges.set(k, (edges.get(k) ?? 0) + 1)
  }
}
console.log([...edges].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${String(v).padStart(4)}  ${k}`).join("\n"))
