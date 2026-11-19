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
import { RunManager } from "./run-manager.js"
import { agentAdapterToRunner } from "../adapter/agent-adapter.js"
import { PiAgentAdapter } from "../adapter/pi-agent-adapter.js"
import { renderWorkflowRunResult } from "../tools/render-text.js"
import { runWorkflow } from "../engine/runtime/workflow-runtime.js"
import { createRunJournal, persistRunSummary } from "./run-journal.js"
import type { JournalStore } from "../engine/persistence/journal.js"
import type { RuntimeEventBus } from "../engine/events/runtime-event-bus.js"
import type {
  ScheduleManagerLike,
  ScheduleRunInfo,
  ScheduleStartDeps,
  ScheduleStartInput,
} from "../engine/schedule/manager-like.js"

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
}

export class PiScheduleRunner implements ScheduleManagerLike {
  private readonly runManager: RunManager
  private readonly deliver?: (text: string) => Promise<void>
  private readonly cwd?: string
  private readonly agentDir?: string
  private readonly eventBus?: RuntimeEventBus
  private readonly journalOverride?: JournalStore
  private readonly agentFactory?: (cwd: string) => unknown

  constructor(options: PiScheduleRunnerOptions) {
    this.runManager = options.runManager
    this.deliver = options.deliver
    this.cwd = options.cwd
    this.agentDir = options.agentDir
    this.eventBus = options.eventBus
    this.journalOverride = options.journal
    this.agentFactory = options.agentFactory
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
    const journal = this.journalOverride ?? createRunJournal(deps.directory)

    void runWorkflow(input.script, {
      // agentFactory 仅测试注入；生产走 PiAgentAdapter（真实子会话）
      agent: agentAdapterToRunner(
        (this.agentFactory?.(deps.directory) as PiAgentAdapter | undefined) ?? new PiAgentAdapter({ defaultCwd: deps.directory }),
      ),
      cwd: deps.directory,
      signal: run.controller.signal,
      runId,
      args: input.args,
      confirm: input.confirm,
      trigger: input.trigger,
      onAgentUpdate: emitUpdate,
      onRuntimeEvent: this.eventBus ? (event: any) => this.eventBus!.publish(event) : undefined,
      onAgentJournal: (entry: any) => journal.append(runId, entry.key, entry),
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
