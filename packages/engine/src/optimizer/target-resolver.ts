/**
 * Target 解析（O0）
 *
 * 与 analyze 的 target 语义保持一致，但优化需要**写入边界**，所以额外给出：
 *  - root：允许修改的根目录（apply 时校验路径不越界）
 *  - files：参与分析的 js（相对 root）
 *  - sourceHashes：apply 前二次校验用
 */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { loadRegistry, readWorkflowScript } from "../runtime/workflow-registry.js"
import { toRelKey } from "./session-store.js"

export interface ResolvedTarget {
  kind: "file" | "directory" | "registry"
  ref: string
  /** 绝对路径；写入边界 */
  root: string
  /** 相对 root 的 js 文件（正斜杠） */
  files: string[]
  /** 相对 root 路径 → sha256 */
  sourceHashes: Record<string, string>
  /** 各文件内容（避免上层重复读盘） */
  sources: Array<{ file: string; content: string }>
}

export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`
}

function readJsFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => /\.(m?js)$/.test(n))
      .sort()
  } catch {
    return []
  }
}

/**
 * 解析 target。
 * - 目录：分析目录下全部 js（与 analyze 目录模式一致）
 * - 文件：分析该文件 + 同目录 sibling workflow（与 analyze tree 模式一致），root = 父目录
 * - registry：从注册表脚本反查文件，root = 其父目录
 */
export function resolveTarget(cwd: string, ref: string): ResolvedTarget | string {
  // registry 优先（与 /workflows run 语义一致）
  try {
    const registry = loadRegistry(cwd)
    if (registry.has(ref)) {
      const content = readWorkflowScript(cwd, ref)
      const entry = registry.get(ref)!
      const rel = entry.filePath
      if (!rel) return `注册表条目 ${ref} 缺少脚本路径`
      const abs = path.resolve(cwd, rel)
      if (!fs.existsSync(abs)) return `注册表条目指向的脚本不存在：${rel}`
      const root = path.dirname(abs)
      const names = readJsFiles(root)
      const sources = names.map((n) => ({ file: n, content: fs.readFileSync(path.join(root, n), "utf8") }))
      return {
        kind: "registry",
        ref,
        root,
        files: names,
        sourceHashes: Object.fromEntries(sources.map((s) => [s.file, sha256(s.content)])),
        sources: sources.map((s) => (s.file === path.basename(abs) ? { ...s, content } : s)),
      }
    }
  } catch {
    // registry 缺失时按路径处理
  }

  const abs = path.resolve(cwd, ref)
  if (!fs.existsSync(abs)) return `找不到目标：${ref}（相对当前目录 ${cwd} 解析）`

  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch (e) {
    return `无法访问 ${ref}：${String((e as Error)?.message ?? e)}`
  }

  if (stat.isDirectory()) {
    const names = readJsFiles(abs)
    if (names.length === 0) return `目录下没有 .js 文件：${ref}`
    const sources = names.map((n) => ({ file: n, content: fs.readFileSync(path.join(abs, n), "utf8") }))
    return {
      kind: "directory",
      ref,
      root: abs,
      files: names,
      sourceHashes: Object.fromEntries(sources.map((s) => [s.file, sha256(s.content)])),
      sources,
    }
  }

  const root = path.dirname(abs)
  const names = readJsFiles(root)
  const sources = names.map((n) => ({ file: n, content: fs.readFileSync(path.join(root, n), "utf8") }))
  return {
    kind: "file",
    ref,
    root,
    files: names,
    sourceHashes: Object.fromEntries(sources.map((s) => [s.file, sha256(s.content)])),
    sources,
  }
}

/** 校验一个相对路径是否允许被 patch（防路径穿越与敏感目录） */
export function isAllowedPatchPath(relPath: string): boolean {
  const rel = toRelKey(relPath)
  if (!rel || rel.startsWith("/") || rel.includes("..")) return false
  if (/^(\.git|node_modules|dist|thirdparties|\.pi)\//.test(rel)) return false
  if (/^\.git$|^node_modules$|^dist$/.test(rel)) return false
  return /\.(m?js)$/.test(rel)
}
