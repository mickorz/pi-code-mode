/**
 * policy-lite 类型定义 —— Agent 工具调用的授权裁决（M1 最小集）
 *
 * 三层分工（执行计划 v3）：
 *   Policy Gate（本包，纯函数）：未知工具 / 危险命令 / 类别级规则
 *   PermitStore（本包）：双阶段授权凭证（tool_call 签发 -> execute 一次性消费）
 *   FileService / CommandExecutor（packages/execution）：边界强制与真实执行
 *
 * M1 裁决只产生 allow / deny（ask 在 headless 场景 fail-closed 为 deny，M3 再引入审批 UI）。
 */

export type Decision = "allow" | "ask" | "deny"

/** 受控工具类别（M1 最小集；M3 扩展 web/mcp_call 等） */
export type ToolCategory = "run_command" | "read_file" | "write_file" | "edit_file"

export interface PolicyInput {
  toolName: string
  input: Record<string, unknown>
  cwd: string
}

export interface PolicyResult {
  decision: Decision
  /** 机器可读原因码（进审计与 block reason） */
  reason: string
  category?: ToolCategory
}

export interface PolicyConfig {
  /** 额外放行的工具名（受控 4 工具之外的白名单；缺省空） */
  extraTools?: readonly string[]
  /** 危险命令黑名单开关（缺省启用） */
  dangerousCommandsEnabled?: boolean
}
