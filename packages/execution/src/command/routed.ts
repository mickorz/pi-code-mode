/**
 * RoutedCommandExecutor —— 沙盒 / 控制面 路由（M2-W4 路线 A）
 *
 * 关键性质：**路由在调用前就确定，不存在失败后自动转控制面**。
 *   - 命中控制面规则 → ControlPlaneExecutor（需审批）
 *   - 其余一律 → 沙盒执行器（失败就是失败）
 *
 * 这样"沙盒失败 → 悄悄用宿主跑"这种静默降级在结构上不可能发生。
 */

import { ControlPlaneExecutor } from "./control-plane.js"
import type { CommandExecutor, SandboxCommandRequest, SandboxCommandResult } from "./types.js"

export class RoutedCommandExecutor implements CommandExecutor {
  constructor(
    private readonly sandbox: CommandExecutor,
    private readonly controlPlane: ControlPlaneExecutor,
  ) {}

  /** 该命令将被路由到哪一侧（供审计/观测，不参与执行决策） */
  routeOf(command: string): "control-plane" | "sandbox" {
    return this.controlPlane.match(command) ? "control-plane" : "sandbox"
  }

  async execute(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    if (this.controlPlane.match(request.command)) {
      return this.controlPlane.execute(request)
    }
    return this.sandbox.execute(request)
  }
}
