/**
 * pi-code-mode extension 入口（pi package manifest 指向本文件）
 *
 * 流程：
 *   pi 加载本扩展 -> registerTool("workflow") -> 模型发起 workflow 调用
 *     -> 取脚本（scriptPath 或 script 字面量） -> parseWorkflowScript 校验 meta
 *     -> PiAgentAdapter + agentAdapterToRunner 组装 AgentSessionRunner
 *     -> runWorkflow 执行（journal 落盘 .pi/workflows/journal/） -> 渲染结果回传主会话
 *
 * M1 范围：前台阻塞执行 + journal 落盘。background/resume/checkpoint 通道按 R3 阶段表属 M2/M3。
 */

import { Type } from "typebox"
import fs from "node:fs"
import path from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { JournalStore } from "../src/engine/persistence/journal.js"
import { parseWorkflowScript } from "../src/engine/runtime/vm.js"
import { runWorkflow } from "../src/engine/runtime/workflow-runtime.js"
import { loadRegistry, readWorkflowScript, workflowsDir } from "../src/engine/runtime/workflow-registry.js"
import { renderWorkflowRunResult } from "../src/tools/render-text.js"
import { agentAdapterToRunner } from "../src/adapter/agent-adapter.js"
import { PiAgentAdapter } from "../src/adapter/pi-agent-adapter.js"

const JOURNAL_DIR = ".pi/workflows/journal"

export default function extension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "执行一个动态工作流脚本（JavaScript DSL）：用 agent()/parallel()/pipeline()/sequence()/phase() 等原语编排多个子 Agent。" +
      "传 script（脚本内容）或 scriptPath（相对项目根的脚本路径，或注册表工作流名）。脚本需以 export const meta = {...} 开头，至少调用一次 agent()。",
    promptSnippet: "workflow: orchestrate multiple sub-agents with a JavaScript DSL script",
    promptGuidelines: [
      "编写 workflow 脚本前先阅读 workflow-authoring skill；脚本必须以 meta 开头、至少一次 agent()、显式 return 结果",
    ],
    parameters: Type.Object({
      script: Type.Optional(Type.String({ description: "workflow 脚本完整内容（ESM，首条语句 export const meta）" })),
      scriptPath: Type.Optional(
        Type.String({ description: "脚本路径（相对项目根）或注册表工作流名（.pi/workflows/ 下的脚本）" }),
      ),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "暴露给脚本的 args 全局" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd ?? process.cwd()

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
        return toolError("必须提供 script 或 scriptPath 参数")
      }

      // 2. 校验 meta（语法 + 首条 meta 语句）
      try {
        parseWorkflowScript(script)
      } catch (e) {
        return toolError(`脚本校验失败: ${String((e as Error)?.message ?? e)}`)
      }

      // 3. 组装 runner 并执行（journal 落盘 .pi/workflows/journal/<runId>.json）
      const adapter = new PiAgentAdapter({ defaultCwd: cwd })
      const journal = new JournalStore(cwd, path.join(cwd, ".pi", "workflows", "journal"))
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      try {
        const outcome = await runWorkflow(script, {
          args: params.args,
          agent: agentAdapterToRunner(adapter),
          cwd,
          signal: signal ?? undefined,
          runId,
          onAgentJournal: (entry) => journal.append(runId, entry.key, entry),
        })
        const text = renderWorkflowRunResult(outcome, { sourceLabel, runId })
        return {
          content: [{ type: "text", text }],
          details: { runId, sourceLabel },
          structuredContent: { runId, result: outcome.result ?? null },
        }
      } catch (e) {
        const msg = String((e as Error)?.message ?? e)
        return {
          content: [{ type: "text", text: `[workflow 失败] runId=${runId}\n${msg}` }],
          details: { runId, sourceLabel, error: msg },
        }
      }
    },
  })
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: `[workflow 参数错误] ${message}` }],
    details: { error: message },
  }
}
