/**
 * Policy Gate —— Agent 工具调用的第一阶段授权（纯函数，无 IO）
 *
 * 分工（执行计划 v3）：本层管"类别级已知风险"（未知工具 / 危险命令）；
 * 路径边界由 execution/files/path-boundary 在执行层强制；执行授权由 PermitStore
 * 在 Tool.execute 二次验证。ask 在 M1 的 headless 场景 fail-closed 为 deny。
 */

import { analyzeCommand } from "./command-analysis.js"
import type { PolicyConfig, PolicyInput, PolicyResult, ToolCategory } from "./types.js"

/** 受控工具名 -> 类别（不在表内即未知工具，拒绝） */
export const CONTROLLED_TOOLS: Readonly<Record<string, ToolCategory>> = {
  run_command: "run_command",
  read_file: "read_file",
  write_file: "write_file",
  edit_file: "edit_file",
}

export function evaluateToolCall(input: PolicyInput, config: PolicyConfig = {}): PolicyResult {
  const category = CONTROLLED_TOOLS[input.toolName]
  if (!category && !(config.extraTools ?? []).includes(input.toolName)) {
    return { decision: "deny", reason: "unknown_tool" }
  }
  if (category === "run_command") {
    const command = typeof input.input.command === "string" ? input.input.command : ""
    if (!command.trim()) {
      return { decision: "deny", reason: "empty_command" }
    }
    const analysis = analyzeCommand(command)
    if (analysis.dangerousReason) {
      return { decision: "deny", reason: `dangerous_command:${analysis.dangerousReason}`, category }
    }
    // M1：普通命令 allow 签 Permit，真实执行由 CommandExecutor 决定（M1 默认 fail-closed 拒绝，
    // M2 接 SRT 沙盒）。策略层放行不等于宿主机执行。
    return { decision: "allow", reason: "command_within_policy", category }
  }
  // 文件工具：类别级放行；工作区边界由 WorkspaceFileService 强制（越界即拒绝）
  return { decision: "allow", reason: "file_tool_within_policy", category }
}
