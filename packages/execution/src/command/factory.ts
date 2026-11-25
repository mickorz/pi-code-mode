/**
 * CommandExecutor 工厂 —— 按平台选择实现（fail-closed 默认）
 *
 * darwin / linux        -> SrtCommandExecutor（真实 OS 级隔离）
 * win32（默认）          -> UnavailableCommandExecutor（明确拒绝，绝不降级宿主执行）
 * win32 + windowsBackend -> SrtCommandExecutor（M2-W0 显式 opt-in，需先完成系统安装与安全验收）
 * 其他平台              -> UnavailableCommandExecutor
 *
 * 安全性论证：即使 SRT 初始化失败，SrtCommandExecutor 只返回 isolation_unavailable
 * 的 blocked 结果——任何路径都不会退化成宿主机直接执行。
 */

import type { CommandExecutor } from "../command/types.js"
import { UnavailableCommandExecutor } from "../command/types.js"
import { sandboxPlatformSupported } from "../sandbox/sandbox-config.js"
import { SrtCommandExecutor } from "../sandbox/srt-executor.js"

export interface CommandExecutorFactoryOptions {
  platform?: NodeJS.Platform
  /** 工作区注册表（Runtime 权威）：提供后 deny 集合由注册表决定，调用方无法自行指定 */
  workspaceRegistry?: import("../workspace/registry.js").WorkspaceRegistry
  /**
   * Windows 后端显式 opt-in（SRT >= 0.0.83 的 srt-win / mxc）。
   * 缺省不设置 = Windows 保持 unsupported。仅在 M2-W0 验证通过后由产品决策开启。
   */
  windowsBackend?: "srt-win" | "mxc"
}

export function createCommandExecutor(options: CommandExecutorFactoryOptions = {}): CommandExecutor {
  const platform = options.platform ?? process.platform
  if (sandboxPlatformSupported(platform)) {
    return new SrtCommandExecutor({
      platform,
      ...(options.workspaceRegistry ? { workspaceRegistry: options.workspaceRegistry } : {}),
    })
  }
  if (platform === "win32" && options.windowsBackend) {
    return new SrtCommandExecutor({
      platform,
      windowsBackend: options.windowsBackend,
      ...(options.workspaceRegistry ? { workspaceRegistry: options.workspaceRegistry } : {}),
    })
  }
  return new UnavailableCommandExecutor(
    `isolation_unavailable：平台 ${platform} 无受支持的 OS 级隔离后端（Windows 需先完成 srt-win 安装与安全验收）`,
  )
}
