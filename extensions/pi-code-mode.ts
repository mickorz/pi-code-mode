/**
 * pi-code-mode extension 入口（pi package manifest 指向本文件）
 *
 * 流程：
 *   pi 加载本扩展 -> registerTool(workflow / workflow_control) -> 模型调用
 *     -> 取脚本（scriptPath 或 script 字面量） -> parseWorkflowScript 校验 meta
 *     -> PiAgentAdapter（全局并发闸包装） + agentAdapterToRunner 组装 runner
 *     -> runWorkflow 执行（journal 落盘 .pi/workflows/journal/） -> 渲染结果回传主会话
 *
 * RunManager 模块级单例：同进程多会话共享，workflow_control 可跨会话查询/取消。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { RunManager, withGlobalGate } from "../src/manager/run-manager.js"
import { PiAgentAdapter } from "../src/adapter/pi-agent-adapter.js"
import { makeWorkflowTool, makeWorkflowControlTool, type WorkflowToolDeps } from "../src/tools/workflow-tools.js"

const runManager = new RunManager(16)

function makeDeps(cwd?: string): WorkflowToolDeps {
  return {
    runManager,
    // 全局并发闸：跨 run 兜底（run 级限流在 runtime 内，此处是全局第二道）
    adapterFactory: () => withGlobalGate(new PiAgentAdapter({ defaultCwd: cwd ?? process.cwd() }), runManager.gate),
    cwd,
  }
}

export default function extension(pi: ExtensionAPI): void {
  pi.registerTool(makeWorkflowTool(makeDeps()) as any)
  pi.registerTool(makeWorkflowControlTool(makeDeps()) as any)
}
