// 契约共享类型: Engine 与 Adapter 的唯一接缝定义
// 本文件是 dev-docs/design/adapter-contract.md 第 2 章的可执行版本
export interface AgentAdapter {
  execute(request: AgentRequest, ctx: ExecutionContext): Promise<AgentResult>;
  /** 幂等; 未知 id 静默成功 */
  cancel(executionId: string): Promise<void>;
}

export interface ExecutionContext {
  /** Engine 生成的全局唯一执行标识（uuid）; 取消路由与日志关联的唯一键 */
  executionId: string;
  runId: string;
  phase?: string;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentRequest {
  prompt: string;
  model?: string;
  cwd?: string;
  tools?: ToolPolicy;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** P0/M1 基础结构化透传; typebox 校验与修复循环属 M2 */
  outputSchema?: object;
}

export interface AgentResult {
  status: "ok" | "error" | "cancelled" | "timeout";
  output: { type: "text" | "structured"; value: unknown };
  /** 非 ok 终态允许缺省; 缺省即未知, 消费方禁止按 0 参与统计 */
  usage?: { inputTokens: number; outputTokens: number };
  sessionId: string;
  error?: { kind: ErrorKind; message: string };
}

export type ErrorKind =
  | "aborted"
  | "timeout"
  | "model"
  | "session"
  | "schema"
  | "unknown";

export type ToolPolicy = {
  excludeTools?: string[];
  noExtensions?: boolean;
  allowTools?: string[];
};

export type AgentEvent =
  | { type: "session-created"; executionId: string; sessionId: string }
  | { type: "attempt"; executionId: string; attempt: number }
  | { type: "record"; executionId: string; record: Record<string, unknown> };
