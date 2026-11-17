/**
 * 共享类型定义
 */

/** Agent 级 MCP 权限策略（纯数据；实现见 src/mcp/mcp-policy.ts 的 filterMcpConfig） */
export interface McpPolicy {
  /** 总开关；false 时该 Agent 不装配任何 MCP 能力 */
  enabled: boolean
  /** server 白名单；undefined = 拒绝全部（默认拒绝原则，M0-2A 实证：未授权 server 零连接） */
  servers?: string[]
  /** 工具白名单，规范名 "<server>:<tool>"，支持 "<server>:*" / "<server>:get_*"；未命中者 hidden */
  allowTools?: string[]
  /** 工具黑名单，规范名同上；优先级高于 allowTools 与 server exposure（F12 官方匹配语义保证） */
  denyTools?: string[]
  /** per-server exposure 覆盖（pi 原生语义）；缺省时开放工具按 codemode 处理 */
  exposure?: Record<string, "direct" | "codemode" | "deferred" | "hidden">
}

/** MCP 工具调用安全摘要（M2 审计；不存完整参数与返回值，v3 P1-1） */
export interface McpToolCallSummary {
  /** mcp__<server>__<tool> 全名（F14：server 名中 - 已替换为 _） */
  toolName: string
  /** 所属 server 名（M4 直调审计用） */
  server?: string
  status: "ok" | "error"
  /** 参数字节量（不存参数内容） */
  argsBytes: number
  /** 脱敏后的参数键名列表（REDACT_KEY 命中键替换后仍列出键名） */
  argsKeys?: string[]
  durationMs?: number
  /** 错误摘要（脱敏限长后） */
  error?: string
  /** pi 内部调用 id（start/end 事件配对） */
  toolCallId?: string
  /** codemode 脚本内调用时的父调用 id（F18：可归因到脚本调用） */
  parentToolCallId?: string
}

/** 单个 agent 的 token 用量（由 Adapter 从 prompt 响应中提取） */
export interface AgentUsage {
  input?: number
  output?: number
  total?: number
  /** 该次调用的货币成本（provider 上报时才有，美元） */
  cost?: number
}

/** agent 记录状态 */
export type AgentRecordStatus = "running" | "ok" | "failed" | "aborted"

/** token 用量拆分（Node Inspector 展示用） */
export interface AgentUsageSplit {
  inputTokens?: number
  outputTokens?: number
}

/**
 * 单次真实执行记录（FR-7）：executionId = runId:callIndex:attempt。
 * retry 的每个 attempt 一条；journal 回放不产生新执行。
 */
export interface AgentExecutionRecord {
  executionId: string
  /** 尝试序号，1 起算 */
  attempt: number
  status: "ok" | "failed" | "aborted"
  label?: string
  sessionId?: string
  error?: string
  startedAt?: number
  durationMs?: number
  usage?: AgentUsageSplit
}

/** 子 workflow invocation 的执行记录（v0.9 Observability：wall-clock 统计与 TUI 树源）
 *  四身份：workflowId（定义稳定 id，meta.id 可选）/ name（定义显示名）/ label（实例显示名）/ scopePath（实例稳定运行时身份） */
export interface WorkflowExecutionRecord {
  /** Definition Stable Identity：meta.id（旧脚本无则 undefined；现在开始记录，将来免迁移） */
  workflowId?: string
  /** Definition Display Name：meta.name */
  name: string
  /** Invocation Display Name：调用方 label 或 name */
  label: string
  /** journal 身份段：root 为 "root"，child 为 wfN */
  keySegment: string
  /** 展示身份：scope 链 label 数组（给人看；同名冲突时靠 scopePath 区分） */
  displayPath: string[]
  /** 稳定身份：scope 链 keySegment 数组（给机器识别/去重；如 ["root","wf0","wf2"]） */
  scopePath: string[]
  startedAt: number
  endedAt?: number
  /** wall-clock（≠ agent duration 之和：并行时 wall 才是真实耗时） */
  durationMs?: number
  status: "running" | "ok" | "failed" | "aborted"
  error?: string
}

/** 单个 agent 的执行记录（用于 F-07 汇总返回） */
export interface AgentRecord {
  /** 形如 runId:callIndex 的稳定标识 */
  id: string
  label: string
  phase?: string
  status: AgentRecordStatus
  /** 展示身份（scope 链 label 数组）；root 的 agent 为 undefined（旧数据兼容） */
  workflowPath?: string[]
  /** 稳定身份（scope 链 keySegment 数组）；与 workflowPath 同生同灭（TUI 节点反查/按 invocation 聚合用） */
  workflowScopePath?: string[]
  /** 该 agent 开始执行的绝对时间戳（毫秒）；journal 回放不产生（TUI phase 耗时用） */
  startedAt?: number
  tokens?: number
  cost?: number
  error?: string
  durationMs?: number
  /** resume 时从 journal 免费回放（未真实调 LLM） */
  replayed?: boolean
  model?: string
  /** 本次调用的子会话 ID（adapter 建会话后立即回填；F-20 TUI 进子会话用；journal 回放的 agent 无此字段） */
  sessionId?: string
  // ---- Node Inspector 扩展（全部可选；老快照/metadata 无这些字段，读端宽松）----
  /** 最新一次真实执行的标识（runId:callIndex:attempt）；journal 回放时从 entry 恢复 */
  executionId?: string
  /** 最后一次尝试的序号（1 起算） */
  attempt?: number
  /** 结果形态（text / structured）；journal 回放时从 entry.outputType 恢复 */
  outputType?: "text" | "structured"
  /** 结果 2KB 截断预览（已脱敏）；完整内容只在 journal，Node Detail 兜底用 */
  outputPreview?: string
  inputTokens?: number
  outputTokens?: number
  /** 组合链（cmpN id 数组；agent 在 sequence/fallback/race 内执行时携带，纯展示用不参与 journal 寻址，P2-3） */
  compositePath?: string[]
  /** 节点类型标记（P2-4 观测）：缺省为普通 agent；checkpoint 节点用于 TUI 区分「等待人工」与执行中 */
  kind?: "checkpoint"
  /** 总尝试次数（retries+1；重试进度显示 (2/3) 用，#32） */
  maxAttempts?: number
  /** 生效超时上限毫秒（单 agent > run 级；null = 无上限；计时显示 10s/1m 用，#33） */
  timeoutMs?: number | null
  /** 本次尝试的起始时间戳（每次 attempt 重置；运行计时按此显示 1s/8s 而非累计 9s/8s，#33 修正） */
  attemptStartedAt?: number
}

/** Composite 组合节点执行记录（P2-3 观测；与 AgentRecord 同源的展示元数据，不进 journal key） */
export interface CompositeRecord {
  /** scope 内唯一 id：cmpN（compositeSeq 生成；仅展示寻址，与 callSeq/childSeq 严格分离） */
  id: string
  kind: "sequence" | "fallback" | "race"
  label: string
  status: "running" | "ok" | "failed" | "aborted"
  /** 所在 workflow scope 身份链（对齐 WorkflowExecutionRecord.scopePath） */
  scopePath: string[]
  /** 组合链（含自身；嵌套组合的父子关系源） */
  compositePath: string[]
  startedAt?: number
  durationMs?: number
}

/** workflow 脚本 meta 信封 */
export interface WorkflowMeta {
  /** 稳定 ID（Schedule 引用）；缺省用 name */
  id?: string
  name: string
  description?: string
  phases?: Array<{ title: string }>
  /**
   * workflow 直调 MCP 权限声明（M4，默认拒绝）：声明后 VM 内可用 `mcp.call/listTools/listServers`
   * 与官方同款 `tools.mcp__<server>__<tool>` proxy 直调 MCP；未声明时 mcp/tools 调用抛错。
   * root 与 child 各自声明，可达面为与 root 池白名单的交集（child 不能超出 root）。
   */
  mcp?: McpPolicy
}

/** runWorkflow 的返回值 */
export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta
  /** 脚本 return 的值 */
  result: T
  logs: string[]
  phases: string[]
  agents: AgentRecord[]
  /** 全部 workflow invocation 的执行记录（含 root；wall-clock 统计与 TUI 树源，v0.9） */
  workflows: WorkflowExecutionRecord[]
  /** 全部组合节点执行记录（P2-3 观测；TUI 组合层级树源） */
  composites: CompositeRecord[]
  agentCount: number
  /** runTool 调用次数（P4.1：确定性工具节点；纯 Tool Workflow 时 agentCount 为 0） */
  toolCount?: number
  durationMs: number
  runId: string
}

/** journal 条目：key 为 runId:callIndex，hash 覆盖 prompt/model/phase/agentType/schema（P1-1）
 *  Node Inspector 扩展字段（全部可选，老 journal 无这些字段，读端宽松）：
 *  hash/result 仅在 agent 成功时写入（resume 语义不变）；失败 attempt 只进 executions，绝不写 hash。 */
export interface JournalEntry {
  hash: string
  result: unknown
  model?: string
  label?: string
  /** 所属子 workflow 的实例显示名（分支 A：断点反查哪个子流程的哪一步；root 的 agent 无此字段） */
  workflowLabel?: string
  phase?: string
  agentType?: string
  /** 原始 prompt（4KB 截断，仅展示用；不参与 hash 身份） */
  prompt?: string
  sessionId?: string
  outputType?: "text" | "structured" | "unknown"
  executionId?: string
  attempt?: number
  startedAt?: number
  durationMs?: number
  usage?: AgentUsageSplit
  /** 历次尝试记录（追加式，保留最近 10 条；最后一条即最新执行；绝不影响 resume） */
  executions?: AgentExecutionRecord[]
}
