/**
 * ensureWorkspace —— 按需自动登记（M2-W2 接线）
 *
 * workspaceId 由规范化比较键**确定性派生**（无随机数）：同一目录无论登记几次都得到同一 id，
 * 配合注册表按比较键去重，天然幂等。
 * 用短哈希而非完整路径做 id：id 会进日志/审计，路径可能很长且含敏感目录名。
 */

import { createHash } from "node:crypto"
import { normalizeWorkspacePath } from "./path-normalize.js"
import { WorkspaceRegistry, type WorkspaceEntry } from "./registry.js"

/** 由比较键派生稳定 id（12 位十六进制） */
export function workspaceIdForKey(canonicalKey: string): string {
  return `ws-${createHash("sha256").update(canonicalKey).digest("hex").slice(0, 12)}`
}

/**
 * 确保路径已登记并返回条目（不存在则登记）。
 * 路径无效时抛错 —— 调用方必须 fail-closed，不得当作"无需隔离"继续执行。
 */
export function ensureWorkspace(registry: WorkspaceRegistry, rootPath: string): WorkspaceEntry {
  const { canonicalKey } = normalizeWorkspacePath(rootPath)
  const existing = registry.getAll().find((e) => e.key === canonicalKey)
  if (existing) return existing
  return registry.register({ workspaceId: workspaceIdForKey(canonicalKey), rootPath })
}
