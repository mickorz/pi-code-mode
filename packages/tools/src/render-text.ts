/**
 * WorkflowRunResult 的纯文本渲染（无 UI 依赖）
 * 形态对齐 opencode 版语义：状态 + 阶段 + 节点列表 + 结果值
 */

import type { AgentRecord, WorkflowRunResult } from "../../engine/src/types/index.js"

export interface RenderMeta {
  runId?: string
  sourceLabel?: string
}

export function renderWorkflowRunResult(outcome: WorkflowRunResult, meta: RenderMeta = {}): string {
  const lines: string[] = []
  lines.push(`[workflow 完成] ${meta.runId ? `runId=${meta.runId} ` : ""}${meta.sourceLabel ? `source=${meta.sourceLabel}` : ""}`)
  lines.push(`名称: ${outcome.meta.name}${outcome.meta.description ? ` (${outcome.meta.description})` : ""}`)
  lines.push(
    `统计: ${outcome.agentCount} 个 agent / ${outcome.toolCount ?? 0} 个工具节点 / ${outcome.phases.length} 个阶段 / ${outcome.durationMs}ms`,
  )

  if (outcome.phases.length) lines.push(`阶段: ${outcome.phases.join(" -> ")}`)

  const agentLines = outcome.agents.map(renderAgentLine)
  if (agentLines.length) {
    lines.push("节点:")
    for (const l of agentLines) lines.push(`  ${l}`)
  }

  if (outcome.logs.length) {
    lines.push("日志:")
    for (const l of outcome.logs) lines.push(`  ${l}`)
  }

  lines.push("结果:")
  lines.push(JSON.stringify(outcome.result, null, 2))
  return lines.join("\n")
}

function renderAgentLine(a: AgentRecord): string {
  const flag = a.replayed ? " [回放]" : ""
  const dur = a.durationMs != null ? ` ${a.durationMs}ms` : ""
  const tok = a.tokens != null ? ` ${a.tokens}tok` : ""
  return `- ${a.id} ${a.label}${a.phase ? ` (${a.phase})` : ""}: ${a.status}${flag}${dur}${tok}`
}
