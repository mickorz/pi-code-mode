/**
 * pi-code-mode 插件入口
 *
 * M1 阶段：导出引擎与适配层；extension 注册（pi.registerTool）在 M1-3 接入。
 */

export { agentAdapterToRunner } from "../../adapter/src/agent-adapter.js"
export { PiAgentAdapter, type PiAgentAdapterOptions } from "../../adapter/src/pi-agent-adapter.js"
export type {
  AgentAdapter,
  AgentRequest,
  AgentResult,
  AgentEvent,
  ExecutionContext,
  ErrorKind,
  ToolPolicy,
} from "../../adapter/src/types.js"

export { runWorkflow } from "../../engine/src/runtime/workflow-runtime.js"
export { parseWorkflowScript } from "../../engine/src/runtime/vm.js"
export { loadRegistry, readWorkflowScript, workflowsDir } from "../../engine/src/runtime/workflow-registry.js"
export { WorkflowError, WorkflowErrorCode, wrapError } from "../../engine/src/runtime/errors.js"
export type { AgentSessionRunner, AgentRunOptions, AgentExecutionResult } from "../../engine/src/agent/session-runner.js"
export type { AgentRecord, AgentUsage, WorkflowRunResult } from "../../engine/src/types/index.js"
export { JournalStore } from "../../engine/src/persistence/journal.js"
export { createWorktree, removeWorktree } from "../../engine/src/isolation/worktree.js"
