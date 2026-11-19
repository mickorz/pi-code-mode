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
import { agentAdapterToRunner } from "../adapter/agent-adapter.js"
import { PiAgentAdapter } from "../adapter/pi-agent-adapter.js"
import { renderWorkflowRunResult } from "../tools/render-text.js"
import { runWorkflow } from "../engine/runtime/workflow-runtime.js"
import { JournalStore } from "../engine/persistence/journal.js"
import { resolvePlanContext } from "../engine/plan/plan-runner.js"
import type { WorkflowToolDeps } from "../tools/workflow-tools.js"
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
  /** M6：tier 解析（schedule run 此前绕过 tier 池，静默回退默认模型） */
  resolveTier?: WorkflowToolDeps["resolveTier"]
  /** M6：tier 池 */
  resolveTierPool?: WorkflowToolDeps["resolveTierPool"]
  /** M6：schedule 的 Plan 文件路径（可选；相对项目根） */
  planPath?: string
  /** M6：Plan Profile 名 */
  profile?: string
  /** M6：adapter 工厂（测试注入；缺省 PiAgentAdapter + global gate） */
  adapterFactory?: () => import("../adapter/types.js").AgentAdapter
}

export class PiScheduleRunner implements ScheduleManagerLike {
  private readonly runManager: RunManager
  private readonly deliver?: (text: string) => Promise<void>
  private readonly cwd?: string
  private readonly agentDir?: string
  private readonly resolveTier?: WorkflowToolDeps["resolveTier"]
  private readonly resolveTierPool?: WorkflowToolDeps["resolveTierPool"]
  private readonly planPath?: string
  private readonly profile?: string
  private readonly adapterFactory?: () => import("../adapter/types.js").AgentAdapter

  constructor(options: PiScheduleRunnerOptions) {
    this.runManager = options.runManager
    this.deliver = options.deliver
    this.cwd = options.cwd
    this.agentDir = options.agentDir
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

    // M6-P0-3：schedule run 补齐 global gate / tier 池 / journal / Plan（此前全部缺失）
    const journal = new JournalStore(deps.directory, path.join(deps.directory, ".pi", "workflows", "journal"))
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
      agent: agentAdapterToRunner(
        this.adapterFactory
          ? this.adapterFactory()
          : withGlobalGate(
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
    })
      .then((outcome: any) => {
        this.runManager.finish(runId, { status: "completed", resultPreview: JSON.stringify(outcome.result ?? null) })
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
