/**
 * workflow / workflow_control 工具工厂（与 pi extension 接线解耦，便于测试）
 *
 * R3 约定：workflow_control 暴露 list/status/stop（stop + resumeFromRunId 组合覆盖 pause/resume，不单独实现——对齐 opencode 版语义）；
 * pause/resume 等可持久化控制动作属 M3（后台运行落地后），不在本阶段承诺。
 */

import { Type } from "typebox"
import fs from "node:fs"
import path from "node:path"
import { parseWorkflowScript } from "../engine/runtime/vm.js"
import { runWorkflow } from "../engine/runtime/workflow-runtime.js"
import { loadRegistry, readWorkflowScript } from "../engine/runtime/workflow-registry.js"
import { JournalStore } from "../engine/persistence/journal.js"
import { agentAdapterToRunner } from "../adapter/agent-adapter.js"
import type { AgentAdapter } from "../adapter/types.js"
import { renderWorkflowRunResult } from "./render-text.js"
import { RunManager } from "../manager/run-manager.js"

const JOURNAL_DIR = path.join(".pi", "workflows", "journal")

export interface WorkflowToolDeps {
  runManager: RunManager
  /** 每次执行新建 Adapter（带全局闸包装由接线方决定） */
  adapterFactory: () => AgentAdapter
  cwd?: string
  /** 后台 run 完成后回传主会话的通道（extension 接线 pi.sendUserMessage） */
  deliver?: (text: string) => Promise<void>
  /** 模型分层解析：tier 名 -> provider/modelId（M4 tier 体系；未配置回退会话默认模型） */
  resolveTier?: (tier: string) => string | undefined
}

/** 渲染 status 详情（agents 各节点状态行）；导出供 /workflows status 子命令复用 */
export function renderRunStatus(run: ReturnType<RunManager["status"]>): string {
  if (!run) return "未找到该 runId（可能从未执行或已超出终态保留窗口）"
  const lines = [
    `runId: ${run.runId}`,
    `状态: ${run.status}${run.label ? `（${run.label}）` : ""}`,
    `启动: ${new Date(run.startedAt).toISOString()}${run.finishedAt ? `  结束: ${new Date(run.finishedAt).toISOString()}` : "  （进行中）"}`,
  ]
  if (run.error) lines.push(`错误: ${run.error}`)
  if (run.resultPreview) lines.push(`结果预览: ${run.resultPreview.slice(0, 300)}`)
  if (run.agents.length) {
    lines.push("节点:")
    for (const a of run.agents) {
      lines.push(`  - ${a.label}${a.phase ? ` (${a.phase})` : ""}: ${a.status}${a.replayed ? " [回放]" : ""}${a.durationMs != null ? ` ${a.durationMs}ms` : ""}`)
    }
  }
  return lines.join("\n")
}

/**
 * /workflows run 子命令参数解析：首个 token 为脚本路径或注册表工作流名，
 * 其余 token 按 key=value 收进 args（值能 JSON.parse 则转类型，否则保持字符串）。
 * 纯函数，命令层与测试共用。
 */
export function parseWorkflowsRunArgs(
  argv: string[],
): { scriptPath?: string; args?: Record<string, unknown>; error?: string } {
  const [scriptPath, ...rest] = argv
  if (!scriptPath) return { error: "缺少脚本路径或注册表工作流名" }
  const args: Record<string, unknown> | undefined = rest.length ? {} : undefined
  for (const token of rest) {
    const eq = token.indexOf("=")
    if (eq <= 0) return { error: `参数 "${token}" 不是 key=value 形式` }
    const key = token.slice(0, eq)
    const raw = token.slice(eq + 1)
    let value: unknown = raw
    try {
      value = JSON.parse(raw)
    } catch {
      // 非 JSON 字面量保持字符串原样
    }
    args![key] = value
  }
  return { scriptPath, args }
}

/** workflow 工具定义（前台阻塞执行 + RunManager 注册供 workflow_control 查询/取消） */
export function makeWorkflowTool(deps: WorkflowToolDeps) {
  const cwd = deps.cwd ?? process.cwd()
  return {
    name: "workflow",
    label: "Workflow",
    description:
      "执行一个动态工作流脚本（JavaScript DSL）：用 agent()/parallel()/pipeline()/sequence()/phase() 等原语编排多个子 Agent。" +
      "传 script（脚本内容）或 scriptPath（相对项目根的脚本路径，或注册表工作流名）。脚本需以 export const meta = {...} 开头，至少调用一次 agent()。",
    promptSnippet: "workflow: orchestrate multiple sub-agents with a JavaScript DSL script",
    promptGuidelines: ["编写 workflow 脚本前先阅读 workflow-authoring skill；脚本必须以 meta 开头、至少一次 agent()、显式 return 结果"],
    parameters: Type.Object({
      script: Type.Optional(Type.String({ description: "workflow 脚本完整内容（ESM，首条语句 export const meta）" })),
      scriptPath: Type.Optional(Type.String({ description: "脚本路径（相对项目根）或注册表工作流名" })),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "暴露给脚本的 args 全局" })),
      background: Type.Optional(
        Type.Boolean({ description: "true 时后台执行：立即返回 runId，完成后结果自动回传本会话；用 workflow_control 查询/停止" }),
      ),
      resumeFromRunId: Type.Optional(
        Type.String({ description: "从指定 runId 的 journal 断点续跑：最长未变前缀回放（已完成节点零成本复用），仅变更后的节点真实执行" }),
      ),
      concurrency: Type.Optional(Type.Number({ description: "run 内并发上限（正整数，钳制 16；缺省 CPU 核数-2）" })),
    }),
    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
      // 1. 取脚本
      let script: string
      let sourceLabel: string
      if (params.scriptPath) {
        const registry = loadRegistry(cwd)
        if (registry.has(params.scriptPath)) {
          script = readWorkflowScript(cwd, params.scriptPath)
          sourceLabel = `registry:${params.scriptPath}`
        } else {
          script = fs.readFileSync(path.resolve(cwd, params.scriptPath), "utf-8")
          sourceLabel = `path:${params.scriptPath}`
        }
      } else if (params.script) {
        script = params.script
        sourceLabel = "inline"
      } else {
        return toolText(`[workflow 参数错误] 必须提供 script 或 scriptPath 参数`)
      }

      // 2. 校验 meta
      try {
        parseWorkflowScript(script)
      } catch (e) {
        return toolText(`[workflow 参数错误] 脚本校验失败: ${String((e as Error)?.message ?? e)}`)
      }

      // 3. runId 与 journal（resume 语义：复用旧 runId 对齐 journal key——审计报告 §1.3）
      const resuming = typeof params.resumeFromRunId === "string" && params.resumeFromRunId.length > 0
      const runId = resuming ? params.resumeFromRunId : `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const run = deps.runManager.register(runId, { label: sourceLabel, externalSignal: signal })
      const journal = new JournalStore(cwd, path.join(cwd, JOURNAL_DIR))
      const resumeJournal = resuming ? journal.load(params.resumeFromRunId) : undefined

      // checkpoint 确认通道（M2）：宿主 TUI 的 ui.confirm 对话框；无 ui 环境（headless）走引擎缺省值
      let checkpointSeq = 0
      const confirm = ctx?.ui?.confirm
        ? async (promptText: string) => {
            try {
              return await ctx.ui.confirm(`workflow checkpoint #${++checkpointSeq}`, promptText.slice(0, 200))
            } catch {
              return true // UI 不可用时不阻塞编排
            }
          }
        : undefined

      const runOpts = () => ({
        args: params.args,
        agent: agentAdapterToRunner(deps.adapterFactory()),
        cwd,
        signal: run.controller.signal,
        runId,
        concurrency: typeof params.concurrency === "number" ? params.concurrency : undefined,
        resolveTier: deps.resolveTier,
        resumeJournal,
        replayPolicy: "explicit" as const,
        confirm,
        onAgentJournal: (entry: any) => journal.append(runId, entry.key, entry),
        onAgentUpdate: (record: any) => deps.runManager.attach(runId, record),
      })

      // 4. 后台分支（M3）：立即返回 runId，完成后 deliver 回传主会话
      if (params.background === true) {
        void runWorkflow(script, runOpts())
          .then((outcome) => {
            const preview = JSON.stringify(outcome.result ?? null)
            deps.runManager.finish(runId, { status: "completed", resultPreview: preview })
            return deps.deliver?.(renderWorkflowRunResult(outcome, { runId, sourceLabel: `background:${sourceLabel}` }))
          })
          .catch(async (e) => {
            const msg = String((e as Error)?.message ?? e)
            const cancelled = run.controller.signal.aborted
            deps.runManager.finish(runId, { status: cancelled ? "cancelled" : "failed", error: msg })
            await deps.deliver?.(`[workflow ${cancelled ? "已停止" : "失败"}] runId=${runId}
${msg}
已完成部分在 journal 中，可用 workflow(resumeFromRunId="${runId}") 续跑。`)
          })
        return toolText(
          `后台 run 已提交: runId=${runId}${resuming ? `（resume 自 ${params.resumeFromRunId}，复用其 journal 续跑）` : ""}
用 workflow_control(action=list/status) 查询进度；停止用 action=stop。`,
        )
      }

      // 5. 前台执行
      try {
        const outcome = await runWorkflow(script, runOpts())
        const preview = JSON.stringify(outcome.result ?? null)
        deps.runManager.finish(runId, { status: "completed", resultPreview: preview })
        return {
          content: [{ type: "text" as const, text: renderWorkflowRunResult(outcome, { runId, sourceLabel }) }],
          details: { runId, sourceLabel },
          structuredContent: { runId, result: outcome.result ?? null },
        }
      } catch (e) {
        const msg = String((e as Error)?.message ?? e)
        const cancelled = run.controller.signal.aborted
        deps.runManager.finish(runId, { status: cancelled ? "cancelled" : "failed", error: msg })
        const resumeHint = cancelled ? `
已完成部分在 journal 中，可用 workflow(resumeFromRunId="${runId}") 续跑。` : ""
        return {
          content: [{ type: "text" as const, text: `[workflow ${cancelled ? "已停止" : "失败"}] runId=${runId}
${msg}${resumeHint}` }],
          details: { runId, sourceLabel, error: msg, cancelled },
        }
      }
    },
  }
}

/** workflow_control 工具定义（R3 P0：仅 list/status/cancel） */
export function makeWorkflowControlTool(deps: WorkflowToolDeps) {
  return {
    name: "workflow_control",
    label: "Workflow Control",
    description: "查询或控制 workflow 运行：list 列出全部运行（在途+最近终态）、status 查单次运行详情、stop 停止在途运行（journal 保留，可 resumeFromRunId 续跑）。",
    promptSnippet: "workflow_control: list/status/cancel workflow runs",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("stop")], {
        description: "list=列出全部；status=查详情；stop=停止在途 run（journal 保留可续跑）",
      }),
      runId: Type.Optional(Type.String({ description: "status/cancel 必填；list 忽略" })),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: any) {
      if (params.action === "list") {
        const runs = deps.runManager.list()
        if (!runs.length) return toolText("当前没有任何 workflow 运行记录")
        const lines = runs.map((r) => {
          const t = r.finishedAt ? "终态" : "在途"
          return `- ${r.status.padEnd(9)} ${t} ${r.runId}${r.label ? `（${r.label}）` : ""} agents=${r.agents}${r.error ? ` 错误: ${r.error.slice(0, 80)}` : ""}`
        })
        return toolText(`共 ${runs.length} 个运行:\n${lines.join("\n")}`)
      }
      if (!params.runId) return toolText(`[workflow_control 参数错误] action=${params.action} 需要提供 runId`)
      if (params.action === "status") {
        return toolText(renderRunStatus(deps.runManager.status(params.runId)))
      }
      // stop（journal 保留，stop + resumeFromRunId 组合覆盖 pause/resume）
      const ok = await deps.runManager.cancel(params.runId)
      return toolText(
        ok
          ? `已停止 run: ${params.runId}（在飞子会话一并取消）。已完成部分在 journal 中，可用 workflow(resumeFromRunId="${params.runId}") 续跑。`
          : `未找到运行中的 run: ${params.runId}（可能已完成、已停止或不存在）；用 action=list 查看。`,
      )
    },
  }
}

function toolText(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} }
}
