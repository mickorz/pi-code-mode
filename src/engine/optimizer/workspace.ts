/**
 * 隔离工作区（O1）
 *
 * 为什么复制整棵目录树而不是单个 js：真实 workflow 通过相对 scriptPath 调子流程，
 * 只复制入口会让「验证」变成假验证（子流程读不到 → 跑不起来或行为不同）。
 *
 * 排除目录：.git / node_modules / dist / thirdparties / .pi（含 journal、baseline、优化会话自身）
 */
import fs from "node:fs"
import path from "node:path"

import { sha256 } from "./target-resolver.js"
import { toRelKey } from "./session-store.js"

const EXCLUDE_DIRS = new Set([".git", "node_modules", "dist", "thirdparties", ".pi", ".opencode-workflows"])
const TEXT_EXT = /\.(m?js|cjs|json|md|txt|ya?ml)$/
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_FILES = 2000

export interface WorkspaceManifest {
  createdAt: string
  root: string
  files: Array<{ path: string; hash: string }>
  skipped: Array<{ path: string; reason: string }>
}

export interface CopyResult {
  dir: string
  manifest: WorkspaceManifest
  /**
   * 是否因上限（MAX_FILES / MAX_FILE_BYTES）跳过了文件。
   * true = 隔离工作区不完整，调用方必须拒绝把它的验证结果当作可信结论。
   */
  truncated: boolean
}

/**
 * 把 sourceRoot 的文本文件复制到 destDir，返回清单。
 * 只复制文本类文件：二进制/大文件与 workflow 优化无关，且会拖慢工作区创建。
 */
export function copyWorkspace(sourceRoot: string, destDir: string): CopyResult {
  const files: WorkspaceManifest["files"] = []
  const skipped: WorkspaceManifest["skipped"] = []
  fs.mkdirSync(destDir, { recursive: true })

  const walk = (dir: string, rel: string): void => {
    if (files.length >= MAX_FILES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) {
          skipped.push({ path: relPath, reason: "排除目录" })
          continue
        }
        walk(abs, relPath)
        continue
      }
      if (!TEXT_EXT.test(e.name)) {
        skipped.push({ path: relPath, reason: "非文本文件" })
        continue
      }
      let st: fs.Stats
      try {
        st = fs.statSync(abs)
      } catch {
        continue
      }
      if (st.size > MAX_FILE_BYTES) {
        skipped.push({ path: relPath, reason: `超过 ${MAX_FILE_BYTES} 字节` })
        continue
      }
      const content = fs.readFileSync(abs, "utf8")
      const target = path.join(destDir, relPath)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content, "utf8")
      files.push({ path: toRelKey(relPath), hash: sha256(content) })
    }
  }

  walk(sourceRoot, "")
  const manifest: WorkspaceManifest = { createdAt: new Date().toISOString(), root: toRelKey(sourceRoot), files, skipped }
  fs.writeFileSync(path.join(destDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8")
  // 静默截断会让「隔离验证」不完整却看起来成功 —— 显式上报，由调用方决定拒绝。
  const truncated = files.length >= MAX_FILES
  return { dir: destDir, manifest, truncated }
}

/**
 * 校验生产目录在会话期间未被改动。
 * 返回不一致的文件列表（空 = 未变）。
 */
export function detectSourceChanges(
  root: string,
  expected: Record<string, string>,
): Array<{ path: string; expected: string; actual?: string }> {
  const out: Array<{ path: string; expected: string; actual?: string }> = []
  for (const [rel, hash] of Object.entries(expected)) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) {
      out.push({ path: rel, expected: hash })
      continue
    }
    const actual = sha256(fs.readFileSync(abs, "utf8"))
    if (actual !== hash) out.push({ path: rel, expected: hash, actual })
  }
  return out
}
