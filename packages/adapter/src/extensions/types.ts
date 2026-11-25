/**
 * 受控扩展依赖类型 —— PiAgentAdapter 组装注入（M1）
 *
 * 依赖全部显式注入（端口与适配器模式，对齐仓库架构纪律）：
 *   permits     PermitStore（session 隔离，PiAgentAdapter 每次 execute 新建）
 *   files       WorkspaceFileService（文件工具唯一出口）
 *   executor    CommandExecutor（命令工具唯一出口；M1 默认 fail-closed）
 *   policy      PolicyConfig（类别级规则配置）
 */

import type { CommandExecutor, WorkspaceFileService } from "../../../execution/src/index.js"
import type { PermitStore } from "../../../policy-lite/src/index.js"
import type { PolicyConfig } from "../../../policy-lite/src/types.js"

export interface ControlledExtensionDeps {
  permits: PermitStore
  files: WorkspaceFileService
  executor: CommandExecutor
  policy?: PolicyConfig
  /** 执行身份贯通（审计与日志关联） */
  runId?: string
  executionId?: string
  /** 观测：第二阶段拦截计数（安全审计；不进模型输入） */
  onPermitDenied?: (info: { toolName: string; toolCallId: string }) => void
}
