/**
 * CommandExecutor 工厂 —— 按平台选择实现（fail-closed 默认）
 *
 * darwin / linux：SrtCommandExecutor（真实 OS 级隔离）
 * 其他平台（含 Windows）：UnavailableCommandExecutor（明确拒绝，绝不降级宿主执行）
 *
 * 安全性论证：即使 SRT 在目标机器上初始化失败，SrtCommandExecutor 也只会返回
 * isolation_unavailable 的 blocked 结果——任何路径都不会退化成宿主机直接执行。
 */

import type { CommandExecutor } from "../command/types.js"
import { UnavailableCommandExecutor } from "../command/types.js"
import { sandboxPlatformSupported } from "../sandbox/sandbox-config.js"
import { SrtCommandExecutor } from "../sandbox/srt-executor.js"

export function createCommandExecutor(platform: NodeJS.Platform = process.platform): CommandExecutor {
  if (!sandboxPlatformSupported(platform)) {
    return new UnavailableCommandExecutor(
      `isolation_unavailable：平台 ${platform} 无受支持的 OS 级隔离后端（Windows 需 WSL2/Docker 方案，另行评估）`,
    )
  }
  return new SrtCommandExecutor({ platform })
}
