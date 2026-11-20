/**
 * Runtime Event Protocol —— Runtime 与所有消费端（TUI / Web / 审计）之间的唯一事件契约。
 *
 * 设计要点（对齐 dev-docs/design/workflow-explorer-架构设计.md 第四章）：
 *   - 事件由 Runtime 在产生点同步 publish；sequence 由 Bus 在 publish 时同步分配（每 run 独立递增）
 *   - sequence 代表事件发生顺序，不代表节点执行顺序（并发下 B 可能比 A 先完成）
 *   - eventId = `${runId}:${sequence}`，消费端据此识别重复事件
 *   - 本协议不持久化：Journal 只存 Agent 结果与关键执行元数据（见 explorer/repository）
 *
 * 本文件不依赖任何 TUI 库。
 */

import type {
  AgentRecord,
  CompositeRecord,
  PhaseExecutionRecord,
  ToolExecutionRecord,
  WorkflowExecutionRecord,
} from "../types/index.js"

export type WorkflowEventType =
  | "run.started"
  | "run.finished"
  | "workflow.started"
  | "workflow.finished"
  | "phase.started"
  | "phase.finished"
  | "agent.started"
  | "agent.updated"
  | "agent.finished"
  | "composite.started"
  | "composite.finished"
  | "tool.started"
  | "tool.finished"

/** 生产端 publish 的输入：eventId/sequence/timestamp 由 Bus 补齐 */
export interface WorkflowEventInput {
  runId: string
  type: WorkflowEventType
  /** 节点稳定身份（agent/composite/tool/phase 事件必填；run/workflow 事件可省略） */
  nodeKey?: string
  /** 父节点身份（事件产生时可知则填，树模型仍会按 scopePath 自行推导兜底） */
  parentKey?: string
  /** workflow scope 身份链（对齐 WorkflowExecutionRecord.scopePath） */
  scopePath?: string[]
  payload?: unknown
}

/** 完整事件（消费端所见） */
export interface WorkflowRuntimeEvent extends WorkflowEventInput {
  eventId: string
  sequence: number
  timestamp: number
}

/** 各事件的 payload 形状（弱类型便于演进；消费端按 type 收窄） */
export interface WorkflowEventPayloads {
  "run.started": { label?: string; startedAt: number }
  "run.finished": { status: string; error?: string; finishedAt: number }
  "workflow.started": WorkflowExecutionRecord
  "workflow.finished": WorkflowExecutionRecord
  "phase.started": PhaseExecutionRecord
  "phase.finished": PhaseExecutionRecord
  "agent.started": AgentRecord
  "agent.updated": AgentRecord
  "agent.finished": AgentRecord
  "composite.started": CompositeRecord
  "composite.finished": CompositeRecord
  "tool.started": ToolExecutionRecord
  "tool.finished": ToolExecutionRecord
}
