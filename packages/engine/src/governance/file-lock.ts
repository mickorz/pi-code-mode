/**
 * 跨进程文件锁（M6-P0-4）
 *
 * 实现：`<file>.lock` 用 `openSync(..., "wx")` 原子创建（O_EXCL 语义，跨进程互斥）。
 * 缺点：崩溃残留锁 → 用 mtime 超时判定为 stale 后强制接管。
 *
 * 边界（诚实声明）：
 *  - 适用于同机多进程（pi 会话/CLI 并发），不适用于网络文件系统（NFS 的 O_EXCL 不可靠）
 *  - 锁粒度为「整个 registry 文件」，不做行级锁（任务数级别远小于写放大成本）
 */
import fs from "node:fs"
import path from "node:path"

export interface FileLockOptions {
  /** 抢锁重试上限（毫秒） */
  timeoutMs?: number
  /** 锁文件被认为是 stale 的年龄（毫秒），超时可强制接管 */
  staleMs?: number
  /** 重试间隔（毫秒） */
  retryMs?: number
}

const DEFAULT_LOCK: Required<FileLockOptions> = { timeoutMs: 10_000, staleMs: 30_000, retryMs: 25 }

function sleepSync(ms: number): void {
  // 同步阻塞等待（Node 无同步 sleep；Atomics.wait 在 worker 外也可用）
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 在文件锁保护下执行 fn（同步）。
 * 拿不到锁时抛错（不静默降级为无锁执行——否则失去互斥语义）。
 */
export function withFileLock<T>(lockPath: string, fn: () => T, opts: FileLockOptions = {}): T {
  const cfg = { ...DEFAULT_LOCK, ...opts }
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + cfg.timeoutMs
  let fd: number | undefined

  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx")
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
      break
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== "EEXIST") throw e
      // 检查 stale
      try {
        const stat = fs.statSync(lockPath)
        if (Date.now() - stat.mtimeMs > cfg.staleMs) {
          fs.rmSync(lockPath, { force: true })
          continue
        }
      } catch {
        continue // 锁刚被释放
      }
      if (Date.now() > deadline) {
        throw new Error(`获取文件锁超时（${cfg.timeoutMs}ms）：${lockPath}（若进程已崩溃可删除该锁文件）`)
      }
      sleepSync(cfg.retryMs)
    }
  }

  try {
    return fn()
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(lockPath, { force: true })
    } catch {
      /* ignore */
    }
  }
}

/**
 * 原子写文件（M6-P0-4 修复 Windows rm→rename 崩溃窗口）：
 *  1. 写 `file.tmp-<uniq>`
 *  2. fsync 落盘（确保内容持久）
 *  3. rename 覆盖目标
 *  4. rename 失败（Windows 目标存在）→ 先把目标改名为 `file.bak`，再 rename tmp → file，成功后删除 bak
 *     —— 任何时刻磁盘上都至少有一份完整文件（tmp / bak / file 之一），不会出现「目标已删、新文件未就位」
 */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const uniq = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const tmp = `${file}.tmp-${uniq}`
  const bak = `${file}.bak`

  const writeSynced = (target: string) => {
    const fd = fs.openSync(target, "w")
    try {
      fs.writeFileSync(fd, content, "utf8")
      try {
        fs.fsyncSync(fd)
      } catch {
        /* 某些文件系统不支持 fsync，忽略 */
      }
    } finally {
      fs.closeSync(fd)
    }
  }

  writeSynced(tmp)
  try {
    fs.renameSync(tmp, file)
    return
  } catch {
    /* Windows: rename 覆盖已存在文件可能失败 → 用 bak 中转 */
  }

  // 目标存在：先备份，再替换，最后清理
  let moved = false
  try {
    fs.renameSync(file, bak)
    moved = true
  } catch {
    /* 目标不存在（被并发删掉）→ 直接 rename */
  }
  try {
    fs.renameSync(tmp, file)
  } catch (e) {
    // 回滚：恢复备份，避免丢失唯一事实源
    if (moved) {
      try {
        fs.renameSync(bak, file)
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    throw e
  }
  if (moved) {
    try {
      fs.rmSync(bak, { force: true })
    } catch {
      /* ignore */
    }
  }
}
