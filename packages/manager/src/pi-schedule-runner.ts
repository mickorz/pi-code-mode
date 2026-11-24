/**
 * PiScheduleRunner —— ScheduleManagerLike 契约的 pi 版实现
 *
 * - createRootSession：独立顶层 pi 会话（内存态，noExtensions），schedule 的 agent 子树挂其下
 * - start：后台跑 workflow（RunManager 注册 + PiAgentAdapter），完成后 deliver 回传 + onFinished 写 Record
 * - stop：RunManager.cancel（abort 级联在飞子会话；journal 保留）
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import os from "node:os"
import path from "node:path"
import { RunManager, withGlobalGate } from "./run-manager.js"
import { agentAdapterToRunner } from "../../adapter/src/agent-adapter.js"
import { PiAgentAdapter } from "../../adapter/src/pi-agent-adapter.js"
import { renderWorkflowRunResult } from "../../tools/src/render-text.js"
import { runWorkflow } from "../../engine/src/runtime/workflow-runtime.js"
import { createRunJournal, persistRunSummary } from "./run-journal.js"
import { JournalStore } from "../../engine/src/persistence/journal.js"
import type { RuntimeEventBus } from "../../engine/src/events/runtime-event-bus.js"
import { resolvePlanContext } from "../../engine/src/plan/plan-runner.js"
import type { WorkflowToolDeps } from "../../tools/src/workflow-tools.js"
import type {
  ScheduleManagerLike,
  ScheduleRunInfo,
  ScheduleStartDeps,
  ScheduleStartInput,
} from "../../engine/src/schedule/manager-like.js"

const DEFAULT_AGENT_DIR = path.join(os.homedir(), ".pi", "agent")

export interface PiScheduleRunnerOptions {
  runManager: RunManager
  deliver?: (text: string) => Promise<void>
  cwd?: string
  agentDir?: string
  /**
   * 评审修复 H3/M2：schedule 触发的 run 也是 Explorer 的观察对象，必须接同一条
   * 事件总线与同一份 journal —— 否则该 run 在树里只剩根节点、详情永远无数据。
   */
  eventBus?: RuntimeEventBus
  journal?: JournalStore
  /** 测试注入：缺省用 PiAgentAdapter（真实子会话） */
  agentFactory?: (cwd: string) => unknown
  /** M6：tier 解析（schedule run 此前绕过 tier 池，静默回退默认模型） */
  resolveTier?: WorkflowToolDeps["resolveTier"]
  /** M6：tier 池 */
  resolveTierPool?: WorkflowToolDeps["resolveTierPool"]
  /** M6：schedule 的 Plan 文件路径（可选；相对项目根） */
  planPath?: string
  /** M6：Plan Profile 名 */
  profile?: string
  /** M6：adapter 工厂（测试注入；缺省 PiAgentAdapter + global gate） */
  adapterFactory?: () => import("../../adapter/src/types.js").AgentAdapter
}

export class PiScheduleRunner implements ScheduleManagerLike {
  private readonly runManager: RunManager
  private readonly deliver?: (text: string) => Promise<void>
  private readonly cwd?: string
  private readonly agentDir?: string
  private readonly eventBus?: RuntimeEventBus
  private readonly journalOverride?: JournalStore
  private readonly agentFactory?: (cwd: string) => unknown
  private readonly resolveTier?: WorkflowToolDeps["resolveTier"]
  private readonly resolveTierPool?: WorkflowToolDeps["resolveTierPool"]
  private readonly planPath?: string
  private readonly profile?: string
  private readonly adapterFactory?: () => import("../../adapter/src/types.js").AgentAdapter

  constructor(options: PiScheduleRunnerOptions) {
    this.runManager = options.runManager
    this.deliver = options.deliver
    this.cwd = options.cwd
    this.agentDir = options.agentDir
    this.eventBus = options.eventBus
    this.journalOverride = options.journal
    this.agentFactory = options.agentFactory
    this.resolveTier = options.resolveTier
    this.resolveTierPool = options.resolveTierPool
    this.planPath = options.planPath
    this.profile = options.profile
    this.adapterFactory = options.adapterFactory
  }

  /** 独立顶层会话：内存态 + noExtensions（schedule 触发的 run 不受宿主扩展影响） */
  async createRootSession(_client: unknown, _title: string): Promise<string> {
    const cwd = this.cwd ?? process.cwd()
    const agentDir = this.agentDir ?? DEFAULT_AGENT_DIR
    const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true })
    await loader.reload()
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.create(cwd, agentDir),
      resourceLoader: loader,
    })
    return session.sessionId
  }

  start(deps: ScheduleStartDeps, input: ScheduleStartInput): string {
    const runId = `sched-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const startedAt = Date.now()
    const run = this.runManager.register(runId, { label: `schedule:${input.trigger?.scheduleId ?? "?"}` })
    const emitUpdate = (record: any) => this.runManager.attach(runId, record)
    // journal：优先注入 override（测试/Explorer 同源），否则统一 createRunJournal（resume/审计用）
    const journal = this.journalOverride ?? createRunJournal(deps.directory)

    // M6-P0-3：schedule run 补齐 Plan 上下文与 tier 池（此前静默回退默认模型）
    const planCtx = this.planPath
      ? resolvePlanContext({
          scriptPath: this.planPath.replace(/\.plan\.json$/, ""),
          planPath: this.planPath,
          ...(this.profile ? { profile: this.profile } : {}),
          cwd: deps.directory,
          runId,
        })
      : null
    if (planCtx) for (const note of planCtx.notes) console.warn(`[pi-code-mode] schedule Plan: ${note}`)

    void runWorkflow(input.script, {
      // agentFactory（HEAD，测试注入 PiAgentAdapter）/ adapterFactory（main，测试注入 AgentAdapter）优先；
      // 生产走 withGlobalGate + PiAgentAdapter（真实子会话 + 全局并发闸）
      agent: agentAdapterToRunner(
        (this.agentFactory?.(deps.directory) as PiAgentAdapter | undefined) ??
          this.adapterFactory?.() ??
          withGlobalGate(
            new PiAgentAdapter({ defaultCwd: deps.directory, ...(this.agentDir ? { agentDir: this.agentDir } : {}) }),
            this.runManager.gate,
          ),
      ),
      cwd: deps.directory,
      signal: run.controller.signal,
      runId,
      args: input.args,
      confirm: input.confirm,
      trigger: input.trigger,
      resolveTier: this.resolveTier,
      resolveTierPool: this.resolveTierPool,
      // journal：定时 run 也可 resume / 审计（此前 schedule 无 journal 落盘）
      onAgentJournal: (entry: any) => journal.append(runId, entry.key, entry),
      ...(planCtx ? { budgetGate: planCtx.budgetGate } : {}),
      ...(planCtx?.concurrency !== undefined ? { concurrency: planCtx.concurrency } : {}),
      onAgentUpdate: emitUpdate,
      onRuntimeEvent: this.eventBus ? (event: any) => this.eventBus!.publish(event) : undefined,
      onAgentExecution: (payload: any) => journal.recordExecution(runId, payload.key, payload.execution),
    })
      .then((outcome: any) => {
        this.runManager.finish(runId, { status: "completed", resultPreview: JSON.stringify(outcome.result ?? null) })
        persistRunSummary(journal, runId, outcome, "completed", undefined, { lastSequence: this.eventBus?.lastSequence(runId), startedAt })
        const info: ScheduleRunInfo = {
          runId,
          name: outcome.meta.name,
          status: "completed",
          startedAt,
          endedAt: Date.now(),
          records: outcome.agents,
          logs: outcome.logs,
        }
        input.onFinished?.(info)
        return this.deliver?.(renderWorkflowRunResult(outcome, { runId, sourceLabel: `schedule:${outcome.meta.name}` }))
      })
      .catch((e: any) => {
        const msg = String((e as Error)?.message ?? e)
        const stopped = run.controller.signal.aborted
        this.runManager.finish(runId, { status: stopped ? "cancelled" : "failed", error: msg })
        persistRunSummary(journal, runId, undefined, stopped ? "cancelled" : "failed", msg, { lastSequence: this.eventBus?.lastSequence(runId), startedAt })
        const info: ScheduleRunInfo = {
          runId,
          name: "schedule-run",
          status: stopped ? "stopped" : "failed",
          startedAt,
          endedAt: Date.now(),
          records: [],
          logs: [],
          error: msg,
        }
        input.onFinished?.(info)
        return this.deliver?.(`[schedule run ${stopped ? "已停止" : "失败"}] runId=${runId}\n${msg}`)
      })

    return runId
  }

  async stop(runId: string): Promise<boolean> {
    return this.runManager.cancel(runId)
  }
}
