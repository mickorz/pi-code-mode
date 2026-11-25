/**
 * WorkspaceRegistry —— Runtime 级工作区权限决策（M2-W2 MVP）
 *
 * 职责单一：维护 pi-code-mode 已知的工作区及其生命周期，并据此回答
 * 「当前工作区应当 deny 哪些其他工作区」。
 *
 * 三个职责分离（架构原则）：
 *   Agent   提出执行请求（不知道其他工作区存在）
 *   Runtime 决定权限（本注册表）—— 唯一权威
 *   Sandbox 强制执行权限（MXC + SRT）
 *
 * 生命周期用引用计数（owners），**不因最后一个 Run 结束就删除工作区身份**：
 *  - status 变为 inactive，但条目保留；
 *  - 其他工作区对它的 deny 因此持续有效（W2-04：B 关闭后 A 仍不能读 B）。
 * 只有显式 unregister（且无 owner）才真正移除。
 *
 * fail-closed：路径解析失败、工作区未登记、比较键异常 → 抛错，
 * 由执行层拒绝执行，**绝不退化为空 deny 列表**（那等于无隔离）。
 */

import {
  canonicalKeyOf,
  isAtOrUnder,
  normalizeWorkspacePath,
  type NormalizedWorkspacePath,
} from "./path-normalize.js"

export interface WorkspaceEntry {
  workspaceId: string
  /** 登记时提供的原始路径 */
  rootPath: string
  /** 实际路径（交给沙盒） */
  canonicalRoot: string
  /** 比较键 */
  key: string
  status: "active" | "inactive"
  owners: string[]
  createdAt: number
  lastActiveAt: number
}

export interface RegisterInput {
  workspaceId: string
  rootPath: string
}

export interface IsolationPolicy {
  /** 当前工作区实际路径（交给沙盒作为可写边界） */
  workspace: string
  /** 需要 deny 的其他已登记工作区（实际路径） */
  denyWorkspaces: string[]
  /** 命中但被排除的原因（可观测性；不进模型输入） */
  excluded?: Array<{ workspaceId: string; reason: string }>
}

export class WorkspaceRegistryError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_registered"
      | "owners_present"
      | "path_invalid"
      | "duplicate_id"
      | "unknown_owner",
  ) {
    super(message)
    this.name = "WorkspaceRegistryError"
  }
}

export class WorkspaceRegistry {
  private readonly byId = new Map<string, WorkspaceEntry>()

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  /** 登记（幂等：同一路径重复登记返回既有条目，不重置 owners） */
  register(input: RegisterInput): WorkspaceEntry {
    if (!input.workspaceId?.trim()) {
      throw new WorkspaceRegistryError("workspaceId 不能为空", "path_invalid")
    }
    let normalized: NormalizedWorkspacePath
    try {
      normalized = normalizeWorkspacePath(input.rootPath, { platform: this.platform })
    } catch (e) {
      throw new WorkspaceRegistryError(String((e as Error).message), "path_invalid")
    }

    // 同路径已登记（不同 id）→ 视为同一工作区，返回既有条目
    for (const entry of this.byId.values()) {
      if (entry.key === normalized.canonicalKey) return { ...entry, owners: [...entry.owners] }
    }
    const existing = this.byId.get(input.workspaceId)
    if (existing) {
      if (existing.key === normalized.canonicalKey) return { ...existing, owners: [...existing.owners] }
      throw new WorkspaceRegistryError(
        `workspaceId ${input.workspaceId} 已绑定到其他路径（${existing.canonicalRoot}）`,
        "duplicate_id",
      )
    }

    const now = Date.now()
    const entry: WorkspaceEntry = {
      workspaceId: input.workspaceId,
      rootPath: input.rootPath,
      canonicalRoot: normalized.realPath,
      key: normalized.canonicalKey,
      status: "inactive",
      owners: [],
      createdAt: now,
      lastActiveAt: now,
    }
    this.byId.set(entry.workspaceId, entry)
    return { ...entry, owners: [...entry.owners] }
  }

  /** 取用（引用计数 +1，status -> active） */
  acquire(workspaceId: string, ownerId: string): WorkspaceEntry {
    const entry = this.require(workspaceId)
    if (!ownerId?.trim()) throw new WorkspaceRegistryError("ownerId 不能为空", "unknown_owner")
    if (!entry.owners.includes(ownerId)) entry.owners.push(ownerId)
    entry.status = "active"
    entry.lastActiveAt = Date.now()
    return { ...entry, owners: [...entry.owners] }
  }

  /** 释放（引用计数 -1）；最后一个 owner 释放后 status -> inactive，**条目保留** */
  release(workspaceId: string, ownerId: string): WorkspaceEntry {
    const entry = this.require(workspaceId)
    const idx = entry.owners.indexOf(ownerId)
    if (idx === -1) throw new WorkspaceRegistryError(`owner ${ownerId} 并未持有 ${workspaceId}`, "unknown_owner")
    entry.owners.splice(idx, 1)
    entry.lastActiveAt = Date.now()
    if (entry.owners.length === 0) entry.status = "inactive"
    return { ...entry, owners: [...entry.owners] }
  }

  /** 注销：仍有 owner 时拒绝（防止运行中的任务失去隔离范围） */
  unregister(workspaceId: string): void {
    const entry = this.require(workspaceId)
    if (entry.owners.length > 0) {
      throw new WorkspaceRegistryError(
        `工作区 ${workspaceId} 仍被 ${entry.owners.length} 个 owner 持有，拒绝注销`,
        "owners_present",
      )
    }
    this.byId.delete(workspaceId)
  }

  /**
   * 快照（浅拷贝）：调用方拿到的是副本，直接改 status/owners 不会影响注册表内部状态，
   * 必须经 acquire/release 才是有效变更。
   */
  getAll(): WorkspaceEntry[] {
    return [...this.byId.values()].map((e) => ({ ...e, owners: [...e.owners] }))
  }

  /** 按路径查工作区（自动登记用；未命中返回 undefined） */
  findByPath(target: string): WorkspaceEntry | undefined {
    let key: string
    try {
      key = normalizeWorkspacePath(target, { platform: this.platform }).canonicalKey
    } catch {
      return undefined
    }
    // 精确命中优先
    for (const entry of this.byId.values()) if (entry.key === key) return entry
    // 落在某工作区内部（嵌套目录）→ 归到最长前缀（最深的那个）
    let best: WorkspaceEntry | undefined
    for (const entry of this.byId.values()) {
      if (isAtOrUnder(key, entry.key, this.platform)) {
        if (!best || entry.key.length > best.key.length) best = entry
      }
    }
    return best
  }

  /**
   * 计算隔离策略（核心）。
   * deny 集合 = 所有其他已登记工作区（不论 active/inactive，见 W2-04），
   * 但排除：
   *   - 自身
   *   - 当前工作区的**祖先**工作区（deny 祖先会连带 deny 自己，属配置冲突，明确排除并记录）
   *   - 已被当前工作区覆盖的**子孙**工作区？不排除：子孙仍单独 deny（更严格，无异义）
   */
  getIsolationPolicy(currentWorkspaceId: string): IsolationPolicy {
    const current = this.require(currentWorkspaceId)
    const deny: string[] = []
    const excluded: Array<{ workspaceId: string; reason: string }> = []
    for (const entry of this.byId.values()) {
      if (entry.workspaceId === current.workspaceId) continue
      if (entry.key === current.key) continue
      // 祖先工作区：deny 它会连带 deny 当前工作区，无法同时满足两侧，明确排除并记录
      if (isAtOrUnder(current.key, entry.key, this.platform)) {
        excluded.push({ workspaceId: entry.workspaceId, reason: "ancestor_of_current" })
        continue
      }
      // 子孙工作区：位于当前工作区树内，属于"我自己的目录"。deny 它会切断对自身子树的
      // 合法访问（实测：工具目录 CLI 与其内部 examples/<proj> 同时登记时，CLI 读不到工程）。
      // 语义上"工作区 = 自己拥有的一棵树"，重叠登记因此合并为同一棵有效树。
      // 代价：外层可读内层（已登记为独立工作区的子目录），登记时需知悉这一取舍。
      if (isAtOrUnder(entry.key, current.key, this.platform)) {
        excluded.push({ workspaceId: entry.workspaceId, reason: "descendant_of_current" })
        continue
      }
      deny.push(entry.canonicalRoot)
    }
    return {
      workspace: current.canonicalRoot,
      denyWorkspaces: deny,
      ...(excluded.length ? { excluded } : {}),
    }
  }

  private require(workspaceId: string): WorkspaceEntry {
    const entry = this.byId.get(workspaceId)
    if (!entry) throw new WorkspaceRegistryError(`未登记的工作区：${workspaceId}`, "not_registered")
    return entry
  }
}

export { canonicalKeyOf, isAtOrUnder, normalizeWorkspacePath }
