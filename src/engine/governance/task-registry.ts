/**
 * TaskCheckpoint + TaskRegistry（M3-T1/T3）
 *
 * 一致性规则（五轮评审）：
 *  1. **Checkpoint 是任务是否完成的最终事实源**；Registry 状态可从 Checkpoint 重建
 *  2. 产物写入采用临时文件 + 原子替换（避免半成品）
 *  3. Checkpoint 提交前验证 resultRef 对应产物存在且完整
 *  4. 副作用状态独立管理——Checkpoint 已提交 ≠ 外部操作成功
 *  5. 文件系统原子替换与外部 API 副作用不是同一事务
 *
 * Fencing Token（P0-2）：
 *  - 每次 lease 接管 → leaseGeneration + 1
 *  - 提交必须原子校验 leaseOwner 与 leaseGeneration 均与当前持有者一致
 *  - 旧执行者（暂停后恢复）即使 lease 已过期也无法覆盖新执行者的结果
 */
import fs from "node:fs"
import path from "node:path"

import type { TaskFingerprint } from "./task-fingerprint.js"
import { withFileLock, writeFileAtomic } from "./file-lock.js"

export type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped"

/** 外部副作用四状态（缺一不可） */
export interface SideEffectState {
  /** 任务执行状态 */
  executed: boolean
  /** 产物持久化状态 */
  artifactPersisted: boolean
  /** 外部副作用是否已提交（发布/写库/调外部 API） */
  sideEffectCommitted: boolean
  /** 该副作用是否幂等（非幂等时恢复需人工确认） */
  idempotent: boolean
  /** 副作用幂等键（非幂等操作必须提供，防重复提交） */
  idempotencyKey?: string
}

export interface TaskCheckpoint {
  taskKey: string
  taskFingerprint: string
  /** 分层指纹分项（排查用） */
  fingerprintParts?: TaskFingerprint["parts"]
  status: TaskStatus
  /** 租约持有者（runId） */
  leaseOwner?: string
  leaseExpiresAt?: number
  /** Fencing Token：每次接管 +1 */
  leaseGeneration: number
  attempt: number
  /** 产物引用（相对 tasks 目录的路径） */
  resultRef?: string
  /** 原子提交时间 */
  committedAt?: number
  sideEffect?: SideEffectState
  /** 失败原因（status=failed 时） */
  error?: string
  updatedAt: number
}

export interface TaskRegistryFile {
  version: 1
  workflowId: string
  tasks: Record<string, TaskCheckpoint>
}

export interface AcquireResult {
  ok: boolean
  /** 成功后的 checkpoint（含新 generation） */
  checkpoint?: TaskCheckpoint
  /** 失败原因 */
  reason?: "lease-held" | "already-done" | "fingerprint-mismatch"
  /** 当前持有者信息（失败时） */
  holder?: { leaseOwner?: string; leaseExpiresAt?: number; leaseGeneration: number }
}

const DEFAULT_LEASE_MS = 10 * 60_000

export class TaskRegistry {
  readonly dir: string
  readonly workflowId: string
  private data: TaskRegistryFile

  constructor(input: { dir: string; workflowId: string }) {
    this.dir = input.dir
    this.workflowId = input.workflowId
    this.data = this.load()
  }

  private get file(): string {
    // M6-P0-4：workflowId 进文件名必须清洗（防 ../ 写出目录）
    return path.join(this.dir, `${safeName(this.workflowId)}.tasks.json`)
  }

  private get lockFile(): string {
    return `${this.file}.lock`
  }

  /** 在跨进程文件锁保护下执行：进入临界区时强制从磁盘重读（M6-P0-4 核心修复） */
  private critical<T>(fn: () => T): T {
    return withFileLock(
      this.lockFile,
      () => {
        // 关键：每次临界区都重读磁盘，使 CAS 判定基于最新事实而非构造时快照
        this.data = this.load()
        return fn()
      },
      { timeoutMs: 15_000, staleMs: 30_000 },
    )
  }

  private load(): TaskRegistryFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as TaskRegistryFile
      if (raw?.version === 1 && raw.tasks) return raw
    } catch {
      /* 不存在或损坏 → 空表 */
    }
    return { version: 1, workflowId: this.workflowId, tasks: {} }
  }

  private persist(): void {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2))
  }

  /** 全部任务（只读快照） */
  list(): TaskCheckpoint[] {
    return Object.values(this.data.tasks).sort((a, b) => a.taskKey.localeCompare(b.taskKey))
  }

  get(taskKey: string): TaskCheckpoint | undefined {
    return this.data.tasks[taskKey]
  }

  /**
   * 取得执行权（lease）：
   *  - 已完成（done）→ ok=false reason=already-done（调用方应跳过）
   *  - 被他人持有且未过期 → reason=lease-held
   *  - 可接管（无租约 / 已过期）→ leaseGeneration+1
   */
  acquire(input: {
    taskKey: string
    taskFingerprint: string
    runId: string
    leaseMs?: number
    now?: number
    /** 强制重跑：跳过 already-done 复用（resume=false 场景） */
    force?: boolean
  }): AcquireResult {
    return this.critical(() => this.acquireLocked(input))
  }

  private acquireLocked(input: {
    taskKey: string
    taskFingerprint: string
    runId: string
    leaseMs?: number
    now?: number
    force?: boolean
  }): AcquireResult {
    const now = input.now ?? Date.now()
    const existing = this.data.tasks[input.taskKey]
    if (!input.force && existing?.status === "done" && existing.taskFingerprint === input.taskFingerprint) {
      return {
        ok: false,
        reason: "already-done",
        holder: { ...(existing.leaseOwner ? { leaseOwner: existing.leaseOwner } : {}), ...(existing.leaseExpiresAt ? { leaseExpiresAt: existing.leaseExpiresAt } : {}), leaseGeneration: existing.leaseGeneration },
      }
    }
    if (existing && existing.status === "running" && existing.leaseOwner && existing.leaseOwner !== input.runId) {
      const expires = existing.leaseExpiresAt ?? 0
      if (expires > now) {
        return {
          ok: false,
          reason: "lease-held",
          holder: { leaseOwner: existing.leaseOwner, leaseExpiresAt: expires, leaseGeneration: existing.leaseGeneration },
        }
      }
    }
    // 接管：generation +1
    const next: TaskCheckpoint = {
      taskKey: input.taskKey,
      taskFingerprint: input.taskFingerprint,
      status: "running",
      leaseOwner: input.runId,
      leaseExpiresAt: now + (input.leaseMs ?? DEFAULT_LEASE_MS),
      leaseGeneration: (existing?.leaseGeneration ?? 0) + 1,
      attempt: (existing?.attempt ?? 0) + 1,
      updatedAt: now,
    }
    this.data.tasks[input.taskKey] = next
    this.persist()
    return { ok: true, checkpoint: next }
  }

  /** 续租（长任务） */
  renew(input: { taskKey: string; runId: string; leaseGeneration: number; leaseMs?: number; now?: number }): boolean {
    return this.critical(() => this.renewLocked(input))
  }

  private renewLocked(input: { taskKey: string; runId: string; leaseGeneration: number; leaseMs?: number; now?: number }): boolean {
    const now = input.now ?? Date.now()
    const cp = this.data.tasks[input.taskKey]
    if (!cp || cp.leaseOwner !== input.runId || cp.leaseGeneration !== input.leaseGeneration) return false
    cp.leaseExpiresAt = now + (input.leaseMs ?? DEFAULT_LEASE_MS)
    cp.updatedAt = now
    this.persist()
    return true
  }

  /**
   * 原子提交（Fencing CAS + 产物校验 + 副作用状态）：
   *  - 校验 leaseOwner 与 leaseGeneration（不匹配 → 拒绝，旧执行者无法覆盖新结果）
   *  - 若提供 resultRef，校验文件存在（一致性规则 3）
   *  - 一次性写入 checkpoint（原子替换，一致性规则 2）
   */
  commit(input: {
    taskKey: string
    runId: string
    leaseGeneration: number
    taskFingerprint: string
    result?: unknown
    resultRef?: string
    sideEffect?: Partial<SideEffectState>
    now?: number
  }): { ok: boolean; reason?: "lease-lost" | "artifact-missing"; checkpoint?: TaskCheckpoint } {
    return this.critical(() => this.commitLocked(input))
  }

  private commitLocked(input: {
    taskKey: string
    runId: string
    leaseGeneration: number
    taskFingerprint: string
    result?: unknown
    resultRef?: string
    sideEffect?: Partial<SideEffectState>
    now?: number
  }): { ok: boolean; reason?: "lease-lost" | "artifact-missing"; checkpoint?: TaskCheckpoint } {
    const now = input.now ?? Date.now()
    const cp = this.data.tasks[input.taskKey]
    if (!cp || cp.leaseOwner !== input.runId || cp.leaseGeneration !== input.leaseGeneration) {
      return { ok: false, reason: "lease-lost" }
    }
    // 产物校验（一致性规则 3）
    if (input.resultRef && !fs.existsSync(path.resolve(this.dir, input.resultRef))) {
      return { ok: false, reason: "artifact-missing" }
    }
    // 产物落盘（原子写）
    let resultRef = input.resultRef
    if (input.result !== undefined) {
      // M6-P0-4：artifact 名带指纹片段，避免 safeName 碰撞（"stage:1" vs "stage 1"）互相覆盖
      const fpPart = input.taskFingerprint.replace(/^sha256:/, "").slice(0, 12)
      const rel = path.join("artifacts", `${safeName(input.taskKey)}.${fpPart}.${input.leaseGeneration}.json`)
      writeFileAtomic(path.resolve(this.dir, rel), JSON.stringify(input.result, null, 2))
      resultRef = rel
    }
    const sideEffect: SideEffectState = {
      executed: true,
      artifactPersisted: Boolean(resultRef),
      sideEffectCommitted: input.sideEffect?.sideEffectCommitted ?? false,
      idempotent: input.sideEffect?.idempotent ?? true,
      ...(input.sideEffect?.idempotencyKey ? { idempotencyKey: input.sideEffect.idempotencyKey } : {}),
    }
    const next: TaskCheckpoint = {
      ...cp,
      status: "done",
      taskFingerprint: input.taskFingerprint,
      ...(resultRef ? { resultRef } : {}),
      committedAt: now,
      sideEffect,
      updatedAt: now,
    }
    this.data.tasks[input.taskKey] = next
    this.persist()
    return { ok: true, checkpoint: next }
  }

  /** 标记失败（保留 attempt / generation） */
  fail(input: { taskKey: string; runId: string; leaseGeneration: number; error: string; now?: number }): boolean {
    return this.critical(() => this.failLocked(input))
  }

  private failLocked(input: { taskKey: string; runId: string; leaseGeneration: number; error: string; now?: number }): boolean {
    const now = input.now ?? Date.now()
    const cp = this.data.tasks[input.taskKey]
    if (!cp || cp.leaseOwner !== input.runId || cp.leaseGeneration !== input.leaseGeneration) return false
    cp.status = "failed"
    cp.error = input.error.slice(0, 500)
    cp.leaseExpiresAt = 0 // 释放租约，允许他人接管
    cp.updatedAt = now
    this.persist()
    return true
  }

  /** 读取产物 */
  readResult(taskKey: string): unknown {
    const cp = this.data.tasks[taskKey]
    if (!cp?.resultRef) return undefined
    try {
      return JSON.parse(fs.readFileSync(path.resolve(this.dir, cp.resultRef), "utf8"))
    } catch {
      return undefined
    }
  }

  /** 一致性重建：Registry 状态可从 Checkpoint 校正（规则 1） */
  rebuildFromCheckpoints(): { corrected: number } {
    return this.critical(() => this.rebuildLocked())
  }

  private rebuildLocked(): { corrected: number } {
    let corrected = 0
    for (const cp of Object.values(this.data.tasks)) {
      // done 但产物缺失 → 降级为 failed（避免误判安全完成）
      if (cp.status === "done" && cp.resultRef && !fs.existsSync(path.resolve(this.dir, cp.resultRef))) {
        cp.status = "failed"
        cp.error = "产物缺失（checkpoint 与磁盘不一致，已降级）"
        cp.updatedAt = Date.now()
        corrected++
      }
    }
    if (corrected > 0) this.persist()
    return { corrected }
  }

  /** 统计（恢复报告用） */
  stats(): Record<TaskStatus, number> {
    const out: Record<TaskStatus, number> = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 }
    for (const cp of Object.values(this.data.tasks)) out[cp.status]++
    return out
  }

  /**
   * 恢复判定：给定指纹，判断是否可复用产物
   *  - done + 指纹一致 + 产物存在 + 副作用已确认（或幂等） → reusable
   */
  reusable(taskKey: string, taskFingerprint: string): { reusable: boolean; reason?: string; resultRef?: string } {
    const cp = this.data.tasks[taskKey]
    if (!cp) return { reusable: false, reason: "no-checkpoint" }
    if (cp.status !== "done") return { reusable: false, reason: `status=${cp.status}` }
    if (cp.taskFingerprint !== taskFingerprint) return { reusable: false, reason: "fingerprint-mismatch" }
    if (cp.resultRef && !fs.existsSync(path.resolve(this.dir, cp.resultRef))) {
      return { reusable: false, reason: "artifact-missing" }
    }
    if (cp.sideEffect && !cp.sideEffect.sideEffectCommitted && !cp.sideEffect.idempotent) {
      return { reusable: false, reason: "side-effect-unconfirmed" }
    }
    return { reusable: true, ...(cp.resultRef ? { resultRef: cp.resultRef } : {}) }
  }
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80)
}
