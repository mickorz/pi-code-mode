/**
 * PatchSet 校验与应用（O1）
 *
 * 为什么必须结构化：允许模型返回整文件会改掉无关代码、丢注释、破坏 export，
 * 且无法支持「入口 + 子流程」多文件联动，也无法在 review 里给出可信 diff。
 *
 * 校验顺序：路径白名单 → hash → oldText 唯一 → 行号范围 → 重叠 → JS 可解析 → export meta 未丢
 */
import { parse } from "acorn"
import fs from "node:fs"
import path from "node:path"

import type { PatchSet, PatchFile } from "./session-types.js"
import { isAllowedPatchPath, sha256 } from "./target-resolver.js"

export interface PatchValidationIssue {
  path: string
  reason: string
}

export interface PatchValidationResult {
  ok: boolean
  issues: PatchValidationIssue[]
  /** 已标准化（按 startLine 倒序）的 patch，可直接应用 */
  normalized?: PatchSet
}

function parseOk(source: string): { ok: boolean; error?: string } {
  try {
    parse(source, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

/** 校验 PatchSet 是否可安全应用（不写盘） */
export function validatePatchSet(patch: PatchSet, workspaceDir: string): PatchValidationResult {
  const issues: PatchValidationIssue[] = []
  const normalizedFiles: PatchFile[] = []

  if (patch.schemaVersion !== "1.0") issues.push({ path: "<patchset>", reason: `schemaVersion 必须为 1.0，实际 ${patch.schemaVersion}` })
  if (!Array.isArray(patch.files) || patch.files.length === 0) {
    if (!patch.needsHumanDecision?.length) {
      issues.push({ path: "<patchset>", reason: "没有 edits 也没有 needsHumanDecision（空补丁无意义）" })
    }
    return { ok: false, issues }
  }

  for (const file of patch.files) {
    const rel = file.path.split(path.sep).join("/")
    if (!isAllowedPatchPath(rel)) {
      issues.push({ path: rel, reason: "路径不允许修改（越界或敏感目录或非 js）" })
      continue
    }
    const abs = path.join(workspaceDir, rel)
    if (!fs.existsSync(abs)) {
      issues.push({ path: rel, reason: "工作区中不存在该文件（未在 target 范围内）" })
      continue
    }
    const original = fs.readFileSync(abs, "utf8")

    if (file.expectedSourceHash && sha256(original) !== file.expectedSourceHash) {
      issues.push({ path: rel, reason: "expectedSourceHash 与工作区文件不一致（补丁基于旧版本）" })
      continue
    }
    if (!Array.isArray(file.edits) || file.edits.length === 0) {
      issues.push({ path: rel, reason: "edits 为空" })
      continue
    }

    const sorted = [...file.edits].sort((a, b) => b.startLine - a.startLine)
    // 重叠检测（在原始行号空间做，排序前判断）
    const byAsc = [...file.edits].sort((a, b) => a.startLine - b.startLine)
    for (let i = 1; i < byAsc.length; i++) {
      const prev = byAsc[i - 1]!
      const cur = byAsc[i]!
      if (cur.startLine <= prev.endLine) {
        issues.push({ path: rel, reason: `edits 行区间重叠：${prev.startLine}-${prev.endLine} 与 ${cur.startLine}-${cur.endLine}` })
      }
    }

    // 行号定位：用 startLine-endLine 切片作为原文（天然唯一）。
    // 模型若额外给了 oldText，必须与切片一致，否则视为行号与内容不符 → 拒绝。
    const originalLines = original.split("\n")
    let patched = original
    for (const edit of sorted) {
      if (!edit.relatedCluster) {
        issues.push({ path: rel, reason: `L${edit.startLine} 缺少 relatedCluster（无法追溯为什么要改）` })
        continue
      }
      if (edit.startLine < 1 || edit.endLine < edit.startLine || edit.endLine > originalLines.length) {
        issues.push({ path: rel, reason: `L${edit.startLine}-${edit.endLine} 行号越界（文件 ${originalLines.length} 行）` })
        continue
      }
      const sliced = originalLines.slice(edit.startLine - 1, edit.endLine).join("\n")
      if (edit.oldText !== undefined && edit.oldText.trim().length > 0) {
        const norm = (s: string) => s.replace(/s+/g, " ").trim()
        if (norm(edit.oldText) !== norm(sliced)) {
          issues.push({
            path: rel,
            reason: `L${edit.startLine}-${edit.endLine} oldText 与行号切片不一致（模型行号与内容不符，拒绝以免改错位置）`,
          })
          continue
        }
      }
      // 在 patched 中按切片替换（此时 patched 还没被前面的 edit 影响区域之外的内容；倒序应用保证行号有效）
      const occurrences = patched.split(sliced).length - 1
      if (occurrences === 0) {
        issues.push({ path: rel, reason: `L${edit.startLine}-${edit.endLine} 切片在文件中找不到` })
        continue
      }
      patched = patched.replace(sliced, edit.newText)
    }

    const parsed = parseOk(patched)
    if (!parsed.ok) {
      issues.push({ path: rel, reason: `patch 后无法解析：${parsed.error}` })
      continue
    }
    // workflow 脚本必须保留 export const meta（丢了就不是 workflow 了）
    if (/export\s+const\s+meta\s*=/.test(original) && !/export\s+const\s+meta\s*=/.test(patched)) {
      issues.push({ path: rel, reason: "patch 后丢失 export const meta（不再是合法 workflow）" })
      continue
    }
    // 行数不应剧烈膨胀（>3 倍视为可能整文件重写）
    const before = original.split("\n").length
    const after = patched.split("\n").length
    if (after > before * 3 && after - before > 50) {
      issues.push({ path: rel, reason: `行数膨胀 ${before} → ${after}（疑似整文件重写，拒绝）` })
      continue
    }

    normalizedFiles.push({ ...file, path: rel, edits: sorted })
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, issues: [], normalized: { ...patch, files: normalizedFiles } }
}

export interface ApplyResult {
  ok: boolean
  files: Array<{ path: string; beforeHash: string; afterHash: string }>
  issues: PatchValidationIssue[]
}

/** 把已校验的 patch 写入工作区（生产文件绝不在此处写入） */
export function applyPatchSet(patch: PatchSet, workspaceDir: string): ApplyResult {
  const files: ApplyResult["files"] = []
  for (const file of patch.files) {
    const abs = path.join(workspaceDir, file.path)
    const original = fs.readFileSync(abs, "utf8")
    const lines = original.split("\n")
    let patched = original
    for (const edit of file.edits) {
      const sliced = lines.slice(edit.startLine - 1, edit.endLine).join("\n")
      patched = patched.replace(sliced, edit.newText)
    }
    fs.writeFileSync(abs, patched, "utf8")
    files.push({ path: file.path, beforeHash: sha256(original), afterHash: sha256(patched) })
  }
  return { ok: true, files, issues: [] }
}
