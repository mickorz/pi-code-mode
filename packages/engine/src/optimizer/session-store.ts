/**
 * 优化会话存储（O0）
 *
 * 布局 `.pi/workflows/optimizations/<id>/`：
 *   session.json / before.report.{json,md} / before.dashboard.html
 *   proposal.json / patchset.json / workspace/ / review.md / result.json / backup/
 *
 * 编号规则 `opt-YYYYMMDD-NNN` 同日递增，不覆盖历史。
 */
import fs from "node:fs"
import path from "node:path"

import { writeFileAtomic } from "../governance/file-lock.js"

import type { OptimizationSession, OptimizationStatus } from "./session-types.js"

export const OPTIMIZE_DIR = path.join(".pi", "workflows", "optimizations")

export interface SessionPaths {
  dir: string
  session: string
  beforeJson: string
  beforeMd: string
  beforeDashboard: string
  proposal: string
  patchset: string
  workspace: string
  review: string
  result: string
  backup: string
}

export function sessionPaths(cwd: string, id: string): SessionPaths {
  const dir = path.join(cwd, OPTIMIZE_DIR, id)
  return {
    dir,
    session: path.join(dir, "session.json"),
    beforeJson: path.join(dir, "before.report.json"),
    beforeMd: path.join(dir, "before.report.md"),
    beforeDashboard: path.join(dir, "before.dashboard.html"),
    proposal: path.join(dir, "proposal.json"),
    patchset: path.join(dir, "patchset.json"),
    workspace: path.join(dir, "workspace"),
    review: path.join(dir, "review.md"),
    result: path.join(dir, "result.json"),
    backup: path.join(dir, "backup"),
  }
}

/** 同日递增编号：opt-YYYYMMDD-001 */
export function nextSessionId(cwd: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  const ymd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const prefix = `opt-${ymd}-`
  const base = path.join(cwd, OPTIMIZE_DIR)
  let seq = 1
  try {
    for (const name of fs.readdirSync(base)) {
      if (!name.startsWith(prefix)) continue
      const n = Number(name.slice(prefix.length))
      if (Number.isFinite(n)) seq = Math.max(seq, n + 1)
    }
  } catch {
    // 目录不存在：从 001 开始
  }
  return `${prefix}${String(seq).padStart(3, "0")}`
}

export function readSession(cwd: string, id: string): OptimizationSession | undefined {
  try {
    return JSON.parse(fs.readFileSync(sessionPaths(cwd, id).session, "utf8")) as OptimizationSession
  } catch {
    return undefined
  }
}

export function writeSession(cwd: string, session: OptimizationSession): void {
  const p = sessionPaths(cwd, session.id)
  fs.mkdirSync(p.dir, { recursive: true })
  const next: OptimizationSession = { ...session, updatedAt: new Date().toISOString() }
  // 原子写：session.json 损坏会让后续「找不到优化会话」，且无法从备份恢复
  writeFileAtomic(p.session, JSON.stringify(next, null, 2))
}

/** 原地更新状态与校验结果 */
export function updateSession(
  cwd: string,
  id: string,
  patch: Partial<OptimizationSession> & { status?: OptimizationStatus; validation?: Partial<OptimizationSession["validation"]> },
): OptimizationSession | undefined {
  const cur = readSession(cwd, id)
  if (!cur) return undefined
  const next: OptimizationSession = {
    ...cur,
    ...patch,
    validation: { ...cur.validation, ...(patch.validation ?? {}) },
    updatedAt: new Date().toISOString(),
  }
  writeSession(cwd, next)
  return next
}

/** 列出全部会话（按创建时间倒序） */
export function listSessions(cwd: string): OptimizationSession[] {
  const base = path.join(cwd, OPTIMIZE_DIR)
  let names: string[] = []
  try {
    names = fs.readdirSync(base)
  } catch {
    return []
  }
  const out: OptimizationSession[] = []
  for (const name of names) {
    const s = readSession(cwd, name)
    if (s) out.push(s)
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/**
 * 查找同 target 的未终态会话（重复执行 optimize 时提示继续）。
 * 终态：applied / rolled-back / rejected / failed / discarded / stale
 */
const TERMINAL: OptimizationStatus[] = ["applied", "rolled-back", "rejected", "failed", "discarded", "stale"]

export function findOpenSession(cwd: string, targetRef: string): OptimizationSession | undefined {
  // P2-4：`./wf` 与 `wf` 是同一目标，用解析后的绝对路径比较，
  // 否则同一目标会建出两个会话、互相看不见。
  let needle = targetRef
  try {
    needle = path.resolve(cwd, targetRef)
  } catch {
    /* 保留原串 */
  }
  return listSessions(cwd).find((s) => {
    if (TERMINAL.includes(s.status)) return false
    if (s.target.ref === targetRef) return true
    try {
      return path.resolve(cwd, s.target.ref) === needle
    } catch {
      return false
    }
  })
}

/** 相对路径统一正斜杠（Windows 下 sourceHashes 键必须稳定） */
export function toRelKey(p: string): string {
  return p.split(path.sep).join("/")
}
