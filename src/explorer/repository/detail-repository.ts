/**
 * JournalDetailRepository —— 节点详情读取层（M5）。
 *
 * 边界：只读 Journal，不写、不参与回放判定；Journal 仍是 Agent 结果回放的唯一事实源。
 * Explorer 的详情面板按需读（不把完整 prompt/result 塞进内存树模型）。
 *
 * 身份映射：AgentRecord.id 就是 journal key（root: `runId:callIndex`，child: `runId:wfK:callIndex`），
 * 由 runtime 的 scopedKey 保证，无需二次映射。
 */

import { JournalStore } from "../../engine/persistence/journal.js"
import type { AgentExecutionRecord } from "../../engine/types/index.js"
import type { JournalObservability, JournalRunMetadata } from "../../engine/persistence/journal.js"

export interface AgentDetail {
  /** 原始 prompt 预览（journal 侧 4KB 截断——不是完整 prompt，完整内容未存储） */
  prompt?: string
  result?: unknown
  outputType?: "text" | "structured" | "unknown"
  model?: string
  label?: string
  workflowLabel?: string
  phase?: string
  sessionId?: string
  startedAt?: number
  durationMs?: number
  attempt?: number
  inputTokens?: number
  outputTokens?: number
  /** 历次 attempt 执行记录（失败历史；回放不产生新记录） */
  executions: AgentExecutionRecord[]
}

export class JournalDetailRepository {
  constructor(
    private readonly journal: JournalStore,
    private readonly runId: string,
  ) {}

  /** 某 agent 节点的详情；journal 无记录（未完成/失败且无执行历史）时返回 undefined */
  getAgentDetail(agentId: string): AgentDetail | undefined {
    const entry = this.journal.getEntry(this.runId, agentId)
    if (!entry) return undefined
    return {
      prompt: entry.prompt,
      result: entry.result,
      outputType: entry.outputType,
      model: entry.model,
      label: entry.label,
      workflowLabel: entry.workflowLabel,
      phase: entry.phase,
      sessionId: entry.sessionId,
      startedAt: entry.startedAt,
      durationMs: entry.durationMs,
      attempt: entry.attempt,
      inputTokens: entry.usage?.inputTokens,
      outputTokens: entry.usage?.outputTokens,
      executions: entry.executions ?? [],
    }
  }

  /** 某 agent 的历次执行尝试（Retry / Replay 展示） */
  getAgentExecutions(agentId: string): AgentExecutionRecord[] {
    return this.journal.getEntry(this.runId, agentId)?.executions ?? []
  }

  /** run 级元数据（V2 journal；V1 老文件返回 undefined） */
  getRunMetadata(): JournalRunMetadata | undefined {
    return this.journal.getRunMetadata(this.runId)
  }

  /** run 级观测快照（V2 journal；历史 run 的树兜底来源） */
  getRunObservability(): JournalObservability | undefined {
    return this.journal.getObservability(this.runId)
  }
}
