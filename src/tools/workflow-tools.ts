/**
 * workflow / workflow_control 工具工厂（与 pi extension 接线解耦，便于测试）
 *
 * R3 P0 约定：workflow_control 仅暴露 list/status/cancel；
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
}

/** 渲染 status 详情（agents 各节点状态行） */
function renderRunStatus(run: ReturnType<RunManager["status"]>): string {
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
    }),
    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: any) {
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

      // 3. RunManager 注册（宿主中断 signal 联动取消）+ 执行
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const run = deps.runManager.register(runId, { label: sourceLabel, externalSignal: signal })
      const journal = new JournalStore(cwd, path.join(cwd, JOURNAL_DIR))
      try {
        const outcome = await runWorkflow(script, {
          args: params.args,
          agent: agentAdapterToRunner(deps.adapterFactory()),
          cwd,
          signal: run.controller.signal,
          runId,
          onAgentJournal: (entry) => journal.append(runId, entry.key, entry),
          onAgentUpdate: (record) => deps.runManager.attach(runId, record),
        })
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
        return {
          content: [{ type: "text" as const, text: `[workflow ${cancelled ? "已取消" : "失败"}] runId=${runId}\n${msg}` }],
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
    description: "查询或控制 workflow 运行：list 列出全部运行（在途+最近终态）、status 查单次运行详情、cancel 取消在途运行。",
    promptSnippet: "workflow_control: list/status/cancel workflow runs",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("cancel")], {
        description: "list=列出全部；status=查详情；cancel=取消在途 run",
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
      // cancel
      const ok = await deps.runManager.cancel(params.runId)
      return toolText(ok ? `已发送取消信号: ${params.runId}` : `未找到在途 run: ${params.runId}（可能已完成或从未执行）`)
    },
  }
}

function toolText(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} }
}
