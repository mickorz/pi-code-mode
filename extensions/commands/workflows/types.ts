/**
 * /workflows 子命令共享契约与依赖类型。
 *
 * 子命令文件只需导出一个 Subcommand 对象（usage 帮助行 + run 处理函数），
 * index.ts 汇总成路由表：新增子命令 = 新文件 + index 路由表加一行。
 */

import type { RunManager } from "../../../src/manager/run-manager.js"
import type { WorkflowToolDeps } from "../../../src/tools/workflow-tools.js"

export interface WorkflowsCommandDeps {
  /** RunManager 模块级单例（与 workflow 工具、widget 共享） */
  runManager: RunManager
  /** 构造 workflow 工具依赖（run 子命令复用工具执行链时用） */
  makeDeps: (cwd?: string) => WorkflowToolDeps
  /** 后台 run 结果回传主会话的通道（extension 接线 pi.sendUserMessage） */
  deliver: (text: string) => Promise<void>
}

export interface Subcommand {
  /** 帮助面板中的用法行（不含 "/workflows " 前缀） */
  usage: string
  /** 处理函数；argv 为去掉子命令名后的剩余 token，ctx 为 pi 命令上下文 */
  run(argv: string[], ctx: any, deps: WorkflowsCommandDeps): Promise<void>
}
