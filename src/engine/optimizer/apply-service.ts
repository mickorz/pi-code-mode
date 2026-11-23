/**
 * 会话备份与写回（O3）
 *
 * 唯一允许写生产文件的地方。硬规则（详见执行计划 §2）：
 *  I2  只有 apply 允许写生产文件
 *  I3  apply 前必须验证 source hash 未变化
 *  I4  apply 前必须创建 backup manifest
 *  I5  apply 只能用 writeFileAtomic
 *  I6  apply 后必须重新分析
 *  I7  失败不自动 rollback（保留新状态与 backup，用户显式 rollback）
 */
import fs from "node:fs"
import path from "node:path"

import { writeFileAtomic } from "../governance/file-lock.js"
import { sha256 } from "./target-resolver.js"
import { toRelKey } from "./session-store.js"

export interface BackupEntry {
  /** 相对 target.root 的路径 */
  path: string
  /** 备份文件在 backup/ 下的相对名 */
  backupFile: string
  beforeHash: string
  afterHash: string
}

export interface BackupManifest {
  schemaVersion: "1.0"
  optimizationId: string
  createdAt: string
  targetRoot: string
  files: BackupEntry[]
}

export function backupDir(sessionDir: string): string {
  return path.join(sessionDir, "backup")
}

export function readBackupManifest(sessionDir: string): BackupManifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(backupDir(sessionDir), "manifest.json"), "utf8")) as BackupManifest
  } catch {
    return undefined
  }
}

/** 把文件内容备份到会话 backup/ 目录（不覆盖已有备份：同会话重复 apply 应被上层拒绝） */
export function writeBackupFile(sessionDir: string, relPath: string, content: string): string {
  const dir = backupDir(sessionDir)
  fs.mkdirSync(dir, { recursive: true })
  const safe = toRelKey(relPath).replace(/[\\/]/g, "__")
  const name = `${safe}.bak`
  fs.writeFileSync(path.join(dir, name), content, "utf8")
  return name
}

export function writeBackupManifest(sessionDir: string, manifest: BackupManifest): void {
  const dir = backupDir(sessionDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8")
}

export interface ApplyPlanItem {
  path: string
  /** 新内容（来自工作区 patch 后的文件） */
  content: string
  /** 期望的生产文件当前 hash（apply 前重算校验） */
  expectedSourceHash: string
}

export interface ApplyResult {
  ok: boolean
  applied: BackupEntry[]
  /** 失败时的原因（stale / 备份失败 / 写入失败） */
  error?: string
  /** 校验不通过的文件 */
  stale?: Array<{ path: string; expected: string; actual?: string }>
}

/**
 * 写回生产文件。
 *
 * 顺序（不可调换）：
 *  1. 全部 source hash 重校验（任一不符 → 整体拒绝，不做部分写入）
 *  2. 全部备份写入磁盘（任一失败 → 整体拒绝）
 *  3. 逐文件 writeFileAtomic
 *  4. 写 backup manifest
 *
 * 关键：hash 校验与备份都在**任何写入之前**完成，避免"改了一半才发现 hash 不对"。
 */
export function applyToProduction(input: {
  sessionDir: string
  optimizationId: string
  targetRoot: string
  items: ApplyPlanItem[]
}): ApplyResult {
  // ① 全量 hash 校验
  const stale: NonNullable<ApplyResult["stale"]> = []
  for (const item of input.items) {
    const abs = path.join(input.targetRoot, item.path)
    if (!fs.existsSync(abs)) {
      stale.push({ path: item.path, expected: item.expectedSourceHash })
      continue
    }
    const actual = sha256(fs.readFileSync(abs, "utf8"))
    if (actual !== item.expectedSourceHash) {
      stale.push({ path: item.path, expected: item.expectedSourceHash, actual })
    }
  }
  if (stale.length > 0) {
    return { ok: false, applied: [], error: "生产文件在 review 后发生变化（stale），拒绝写回", stale }
  }

  // ② 全量备份（写盘失败即中止，尚未改动任何生产文件）
  const entries: BackupEntry[] = []
  try {
    for (const item of input.items) {
      const abs = path.join(input.targetRoot, item.path)
      const before = fs.readFileSync(abs, "utf8")
      const backupFile = writeBackupFile(input.sessionDir, item.path, before)
      entries.push({
        path: item.path,
        backupFile,
        beforeHash: sha256(before),
        afterHash: sha256(item.content),
      })
    }
  } catch (e) {
    return { ok: false, applied: [], error: `备份失败（生产文件未改动）：${String((e as Error)?.message ?? e)}` }
  }
  writeBackupManifest(input.sessionDir, {
    schemaVersion: "1.0",
    optimizationId: input.optimizationId,
    createdAt: new Date().toISOString(),
    targetRoot: input.targetRoot,
    files: entries,
  })

  // ③ 原子写回
  for (const item of input.items) {
    const abs = path.join(input.targetRoot, item.path)
    try {
      writeFileAtomic(abs, item.content)
    } catch (e) {
      return {
        ok: false,
        applied: entries.filter((x) => x.path !== item.path),
        error: `写入失败 ${item.path}：${String((e as Error)?.message ?? e)}（已备份，可 rollback）`,
      }
    }
  }

  return { ok: true, applied: entries }
}

export interface RollbackResult {
  ok: boolean
  restored: string[]
  error?: string
  /** 当前生产文件与 afterHash 不符的项（说明 apply 后又被改过） */
  drifted?: Array<{ path: string; expected: string; actual: string }>
}

/**
 * 从 backup manifest 恢复。
 * 若生产文件在 apply 之后又被改动（与 afterHash 不符），拒绝覆盖——避免丢失他人修改。
 */
export function rollbackFromBackup(input: {
  sessionDir: string
  manifest: BackupManifest
  /** 允许覆盖已漂移文件（需用户显式确认） */
  force?: boolean
}): RollbackResult {
  const drift: NonNullable<RollbackResult["drifted"]> = []
  for (const entry of input.manifest.files) {
    const abs = path.join(input.manifest.targetRoot, entry.path)
    if (!fs.existsSync(abs)) continue
    const actual = sha256(fs.readFileSync(abs, "utf8"))
    if (actual !== entry.afterHash) drift.push({ path: entry.path, expected: entry.afterHash, actual })
  }
  if (drift.length > 0 && input.force !== true) {
    return { ok: false, restored: [], error: "生产文件在 apply 后又被改动，拒绝覆盖（如需强制恢复请加 --force）", drifted: drift }
  }

  const restored: string[] = []
  for (const entry of input.manifest.files) {
    const backupAbs = path.join(input.sessionDir, "backup", entry.backupFile)
    if (!fs.existsSync(backupAbs)) {
      return { ok: false, restored, error: `备份文件缺失：${entry.backupFile}` }
    }
    const content = fs.readFileSync(backupAbs, "utf8")
    const abs = path.join(input.manifest.targetRoot, entry.path)
    try {
      writeFileAtomic(abs, content)
      restored.push(entry.path)
    } catch (e) {
      return { ok: false, restored, error: `恢复失败 ${entry.path}：${String((e as Error)?.message ?? e)}` }
    }
  }
  return { ok: true, restored }
}
