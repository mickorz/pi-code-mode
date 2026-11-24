/**
 * CLI 与 runner 共用的 workflow 执行接线。
 *
 * 存在理由：apps/cli 与 apps/runner 都要「在无 pi 会话的进程里跑 workflow」，
 * 执行装配（adapter/journal/tier/事件）必须只有一份，否则两边语义会漂移。
 */
import fs from "node:fs"
import path from "node:path"
import { PiAgentAdapter } from "../../../packages/adapter/src/pi-agent-adapter.js"
import { agentAdapterToRunner } from "../../../packages/adapter/src/agent-adapter.js"
import { loadModelTiers } from "../../../packages/engine/src/agent/model-tiers.js"
import { loadRegistry, readWorkflowScript } from "../../../packages/engine/src/runtime/workflow-registry.js"
import { runWorkflow } from "../../../packages/engine/src/runtime/workflow-runtime.js"
import type { WorkflowRunResult } from "../../../packages/engine/src/types/index.js"
import { createRunJournal, persistRunSummary } from "../../../packages/manager/src/run-journal.js"

/** tier 名 → "provider/modelId"；解析不到返回 undefined，由引擎回退会话默认模型 */
export function makeTierResolver(cwd: string): (tier: string) => string | undefined {
  const tiers = loadModelTiers({ projectDir: cwd })
  return (tier: string) => {
    const entry = tiers[tier]
    if (typeof entry === "string") return entry
    if (Array.isArray(entry)) return entry[0]?.model
    // 档位缺失显式告警（禁止静默改变行为，见 CLAUDE.md 大模型调用规范）
    console.warn(`[pi-code-mode] 档位 "${tier}" 未配置，回退会话默认模型`)
    return undefined
  }
}

/** 解析 workflow：优先按文件路径，其次按 id 从注册表（项目 + 包内置）取 */
export function resolveWorkflowScript(cwd: string, ref: string): { script: string; source: string } {
  const asFile = path.resolve(cwd, ref)
  if (fs.existsSync(asFile) && fs.statSync(asFile).isFile()) {
    return { script: fs.readFileSync(asFile, "utf-8"), source: asFile }
  }
  const registry = loadRegistry(cwd)
  const entry = registry.get(ref)
  if (!entry) {
    const known = [...registry.keys()].join(", ") || "（空）"
    throw new Error(`未找到 workflow "${ref}"（既不是文件，也不在注册表）；已知 id：${known}`)
  }
  return { script: readWorkflowScript(cwd, ref), source: entry.filePath }
}

export interface RunOnceOptions {
  cwd: string
  script: string
  source: string
  args?: unknown
  concurrency?: number
  resumeFromRunId?: string
  signal?: AbortSignal
  /** 统一 Runtime 事件出口（relay / 进度输出用） */
  onRuntimeEvent?: (event: unknown) => void
  onAgentUpdate?: (record: unknown) => void
}

/** 跑一次 workflow：装配与 pi 工具链一致（adapter + journal + tier + 恢复） */
export async function runWorkflowOnce(options: RunOnceOptions): Promise<{
  runId: string
  result?: WorkflowRunResult<unknown>
  error?: unknown
}> {
  const { cwd, script, resumeFromRunId } = options
  const runId = resumeFromRunId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const journal = createRunJournal(cwd)
  const resumeJournal = resumeFromRunId ? journal.load(resumeFromRunId) : undefined
  const startedAt = Date.now()

  try {
    const result = await runWorkflow(script, {
      args: options.args,
      agent: agentAdapterToRunner(new PiAgentAdapter({ defaultCwd: cwd })),
      cwd,
      signal: options.signal,
      runId,
      concurrency: options.concurrency,
      resolveTier: makeTierResolver(cwd),
      resumeJournal,
      replayPolicy: "explicit",
      onAgentJournal: (entry) => journal.append(runId, entry.key, entry),
      onRuntimeEvent: options.onRuntimeEvent as never,
      onAgentUpdate: options.onAgentUpdate as never,
    })
    persistRunSummary(journal, runId, result as never, "ok", undefined, { startedAt })
    return { runId, result }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    persistRunSummary(journal, runId, undefined, "failed", message, { startedAt })
    return { runId, error }
  }
}
