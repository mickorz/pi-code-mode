/**
 * pi-code-mode 插件入口
 *
 * M1 阶段：导出引擎与适配层；extension 注册（pi.registerTool）在 M1-3 接入。
 */

export { agentAdapterToRunner } from "./adapter/agent-adapter.js"
export { PiAgentAdapter, type PiAgentAdapterOptions } from "./adapter/pi-agent-adapter.js"
export type {
  AgentAdapter,
  AgentRequest,
  AgentResult,
  AgentEvent,
  ExecutionContext,
  ErrorKind,
  ToolPolicy,
} from "./adapter/types.js"

export { runWorkflow } from "./engine/runtime/workflow-runtime.js"
export { parseWorkflowScript } from "./engine/runtime/vm.js"
export { loadRegistry, readWorkflowScript, workflowsDir } from "./engine/runtime/workflow-registry.js"
export { WorkflowError, WorkflowErrorCode, wrapError } from "./engine/runtime/errors.js"
export type { AgentSessionRunner, AgentRunOptions, AgentExecutionResult } from "./engine/agent/session-runner.js"
export type { AgentRecord, AgentUsage, WorkflowRunResult } from "./engine/types/index.js"
export { JournalStore } from "./engine/persistence/journal.js"
export { createWorktree, removeWorktree } from "./engine/isolation/worktree.js"
