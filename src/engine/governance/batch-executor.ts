/**
 * BatchExecutor（M3-T2/T4）：清单驱动的批量任务执行 + 任务级 resume
 *
 * 与 runtime 的关系（架构约束：不破坏 Journal 语义）：
 *  - Executor 独立于 workflow vm：负责「任务级」调度/持久化/恢复
 *  - 任务执行器由调用方注入（可包 workflow run、也可包单个 agent）
 *  - Journal 仍归 runtime 管 agent 回放；Checkpoint 管任务产物复用（两通道并存）
 *
 * 恢复语义：
 *  - resume 模式：done + 指纹一致 → 直接复用产物（**不执行**，零 token）
 *  - 指纹不一致 → 重跑（旧产物不复用，但保留历史）
 *  - 并发：同一 taskKey 由 lease 独占（M3-T1），跨 Run 竞争按 Fencing 语义
 */
import path from "node:path"

import { computeTaskFingerprint, contentHash, type TaskFingerprintInput } from "./task-fingerprint.js"
import { TaskRegistry, type SideEffectState, type TaskStatus } from "./task-registry.js"

export interface BatchTask {
  /** 稳定任务键（建议 `${stageId}:${分片标识}`） */
  taskKey: string
  /** 执行单元（返回产物；抛错即失败） */
  run: (ctx: { attempt: number; leaseGeneration: number }) => Promise<unknown>
  /** 指纹输入（缺省用 taskKey + 运行时 prompt 自动生成） */
  fingerprint?: Omit<TaskFingerprintInput, "taskKey">
  /** 外部副作用声明（非幂等任务必须给 idempotencyKey） */
  sideEffect?: Partial<SideEffectState>
}

export interface BatchExecutorOptions {
  workflowId: string
  runId: string
  /** 存储目录（缺省 .pi/workflows/tasks 于 cwd） */
  storageDir?: string
  cwd?: string
  /** 并发上限（缺省 4） */
  concurrency?: number
  /** 是否复用已完成产物（resume 模式）；false = 强制重跑 */
  resume?: boolean
  /** 单个任务最大尝试次数（缺省 1 = 不重试） */
  maxAttempts?: number
  /** 租约时长（缺省 10 分钟） */
  leaseMs?: number
  /** 单任务硬超时（缺省不设；超时即失败并释放租约，防止挂死任务永久占用） */
  taskTimeoutMs?: number
}

export interface TaskOutcome {
  taskKey: string
  status: TaskStatus
  /** 是否复用了历史产物（未执行） */
  reused: boolean
  attempts: number
  durationMs: number
  value?: unknown
  error?: string
}

export interface BatchResult {
  workflowId: string
  runId: string
  outcomes: TaskOutcome[]
  stats: {
    total: number
    reused: number
    executed: number
    succeeded: number
    failed: number
    /** 因已完成而复用节省的执行数（= reused） */
    savedExecutions: number
  }
}

/** 单任务超时包装（超时即 reject，交给失败路径释放租约） */
function withTaskTimeout<T>(run: () => Promise<T>, timeoutMs: number | undefined, taskKey: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return run()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`任务超时（${timeoutMs}ms）：${taskKey}`)), timeoutMs)
    run().then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** 并发限制器（保序执行，超出排队） */
function createLimiter(limit: number) {
  let active = 0
  const queue: Array<() => void> = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve))
    active++
    try {
      return await fn()
    } finally {
      active--
      queue.shift()?.()
    }
  }
}

export class BatchExecutor {
  private readonly registry: TaskRegistry
  private readonly opts: Required<Omit<BatchExecutorOptions, "cwd" | "storageDir" | "taskTimeoutMs">> & {
    cwd: string
    storageDir: string
    taskTimeoutMs?: number
  }

  constructor(options: BatchExecutorOptions) {
    const cwd = options.cwd ?? process.cwd()
    this.opts = {
      workflowId: options.workflowId,
      runId: options.runId,
      cwd,
      storageDir: options.storageDir ?? path.join(cwd, ".pi", "workflows", "tasks"),
      concurrency: Math.max(1, options.concurrency ?? 4),
      resume: options.resume ?? true,
      maxAttempts: Math.max(1, options.maxAttempts ?? 1),
      leaseMs: options.leaseMs ?? 10 * 60_000,
      ...(options.taskTimeoutMs !== undefined ? { taskTimeoutMs: options.taskTimeoutMs } : {}),
    }
    this.registry = new TaskRegistry({ dir: this.opts.storageDir, workflowId: this.opts.workflowId })
  }

  /** 执行清单；resume=true 时跳过已完成且指纹一致的任务 */
  async run(tasks: BatchTask[]): Promise<BatchResult> {
    const limit = createLimiter(this.opts.concurrency)
    // 启动前校正一致性（产物缺失的 done → failed）
    this.registry.rebuildFromCheckpoints()

    const outcomes = await Promise.all(
      tasks.map((task) =>
        limit(async () => {
          const started = Date.now()
          // M6-P1-1：缺 fingerprint 时不再只 hash taskKey（会导致输入变化复用陈旧产物）
          if (!task.fingerprint) {
            return {
              taskKey: task.taskKey,
              status: "failed" as TaskStatus,
              reused: false,
              attempts: 0,
              durationMs: Date.now() - started,
              error:
                "缺少 fingerprint：BatchTask 必须提供 fingerprint（promptHash/inputHash 等），否则无法安全判定产物复用",
            } satisfies TaskOutcome
          }
          const fingerprint = computeTaskFingerprint({ taskKey: task.taskKey, ...task.fingerprint })

          // ① resume：可复用 → 直接返回，零执行
          if (this.opts.resume) {
            const r = this.registry.reusable(task.taskKey, fingerprint.fingerprint)
            if (r.reusable) {
              return {
                taskKey: task.taskKey,
                status: "done" as TaskStatus,
                reused: true,
                attempts: this.registry.get(task.taskKey)?.attempt ?? 0,
                durationMs: Date.now() - started,
                value: this.registry.readResult(task.taskKey),
              } satisfies TaskOutcome
            }
          }

          // ② 取得 lease（Fencing）
          const acquired = this.registry.acquire({
            taskKey: task.taskKey,
            taskFingerprint: fingerprint.fingerprint,
            runId: this.opts.runId,
            leaseMs: this.opts.leaseMs,
            force: !this.opts.resume,
          })
          if (!acquired.ok) {
            if (acquired.reason === "already-done") {
              return {
                taskKey: task.taskKey,
                status: "done" as TaskStatus,
                reused: true,
                attempts: acquired.holder?.leaseGeneration ?? 0,
                durationMs: Date.now() - started,
                value: this.registry.readResult(task.taskKey),
              } satisfies TaskOutcome
            }
            return {
              taskKey: task.taskKey,
              status: "failed" as TaskStatus,
              reused: false,
              attempts: 0,
              durationMs: Date.now() - started,
              error: `无法取得执行权：${acquired.reason}（持有者 ${acquired.holder?.leaseOwner ?? "?"}，generation ${acquired.holder?.leaseGeneration ?? 0}）`,
            } satisfies TaskOutcome
          }

          const leaseGeneration = acquired.checkpoint!.leaseGeneration
          let lastError: string | undefined
          // 租约自动续期（M4-T1）：按 leaseMs 的 1/3 周期续租，避免超长任务被接管
          // M6-P1-1：任务超时后停止续租（否则挂死任务永久占槽且租约永不过期）
          let renewTimer: ReturnType<typeof setInterval> | undefined
          const startRenew = () => setInterval(() => {
            try {
              this.registry.renew({
                taskKey: task.taskKey,
                runId: this.opts.runId,
                leaseGeneration,
                leaseMs: this.opts.leaseMs,
              })
            } catch {
              /* 续期失败不中断任务（提交时仍有 CAS 校验兜底） */
            }
          }, Math.max(1000, Math.floor(this.opts.leaseMs / 3)))

          const clearRenew = () => {
            if (renewTimer) clearInterval(renewTimer)
            renewTimer = undefined
          }

          // 本次运行内尝试计数（与历史 attempt 分离：接管失败任务时历史 attempt 已 >1）
          let localAttempt = 0
          let attempt = 0
          for (localAttempt = 1; localAttempt <= this.opts.maxAttempts; localAttempt++) {
            attempt = localAttempt
            try {
              renewTimer = startRenew()
              if (typeof renewTimer?.unref === "function") renewTimer.unref()
              const value = await withTaskTimeout(
                () => task.run({ attempt, leaseGeneration }),
                this.opts.taskTimeoutMs,
                task.taskKey,
              )
              const committed = this.registry.commit({
                taskKey: task.taskKey,
                runId: this.opts.runId,
                leaseGeneration,
                taskFingerprint: fingerprint.fingerprint,
                result: value,
                ...(task.sideEffect ? { sideEffect: task.sideEffect } : {}),
              })
              if (!committed.ok) {
                lastError = `提交被拒：${committed.reason}`
                break
              }
              clearRenew()
              return {
                taskKey: task.taskKey,
                status: "done" as TaskStatus,
                reused: false,
                attempts: attempt,
                durationMs: Date.now() - started,
                value,
              } satisfies TaskOutcome
            } catch (e) {
              lastError = String((e as Error)?.message ?? e)
              if (localAttempt >= this.opts.maxAttempts) break
            }
          }
          clearRenew()
          this.registry.fail({
            taskKey: task.taskKey,
            runId: this.opts.runId,
            leaseGeneration,
            error: lastError ?? "unknown",
          })
          return {
            taskKey: task.taskKey,
            status: "failed" as TaskStatus,
            reused: false,
            attempts: attempt,
            durationMs: Date.now() - started,
            error: lastError,
          } satisfies TaskOutcome
        }),
      ),
    )

    const reused = outcomes.filter((o) => o.reused).length
    return {
      workflowId: this.opts.workflowId,
      runId: this.opts.runId,
      outcomes,
      stats: {
        total: outcomes.length,
        reused,
        executed: outcomes.length - reused,
        succeeded: outcomes.filter((o) => o.status === "done").length,
        failed: outcomes.filter((o) => o.status === "failed").length,
        savedExecutions: reused,
      },
    }
  }

  /** 恢复报告（failed / pending 清单 + 节省量） */
  report(result: BatchResult): string {
    const failed = result.outcomes.filter((o) => o.status === "failed")
    const lines = [
      `# Batch 执行报告：${result.workflowId} (run ${result.runId})`,
      "",
      `- 任务总数：${result.stats.total}`,
      `- 复用（未执行）：${result.stats.reused}`,
      `- 实际执行：${result.stats.executed}`,
      `- 成功：${result.stats.succeeded} / 失败：${result.stats.failed}`,
      `- 节省执行数：${result.stats.savedExecutions}`,
    ]
    if (failed.length) {
      lines.push("", "## 失败任务（下次 resume 将只重跑这些）")
      for (const f of failed) lines.push(`- \`${f.taskKey}\`：${f.error ?? "unknown"}（尝试 ${f.attempts} 次）`)
    }
    return lines.join("\n")
  }

  /** 快照（供 UI / 报告） */
  snapshot() {
    return { tasks: this.registry.list(), stats: this.registry.stats() }
  }
}
