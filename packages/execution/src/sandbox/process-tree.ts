/**
 * 进程树终止 —— 平台感知（M2-W0c）
 *
 * POSIX：Host 以 detached 启动成为进程组长，`kill(-pid, sig)` 终止整组。
 * Windows：**没有负 PID 进程组语义**，`process.kill(-pid)` 无效；必须用
 *   `taskkill /PID <pid> /T /F`（/T = 整棵进程树，/F = 强制）。
 *   已实测：Windows 下若不这样做，Host 的空信号处理器会让取消变成空操作。
 */

import { spawnSync } from "node:child_process"

export interface KillTreeOptions {
  /** 先试优雅信号（POSIX SIGTERM）；Windows 无优雅信号，直接 taskkill */
  force?: boolean
  platform?: NodeJS.Platform
}

/**
 * 终止 pid 及其派生的全部进程。
 * 返回是否成功发出终止（不保证进程已退出，调用方仍需等待 exit）。
 */
export function killProcessTree(pid: number, options: KillTreeOptions = {}): boolean {
  const platform = options.platform ?? process.platform
  if (!pid || pid <= 0) return false

  if (platform === "win32") {
    // Windows：taskkill /T 遍历进程树，/F 强制。spawnSync 保证调用顺序确定。
    const args = ["/PID", String(pid), "/T"]
    if (options.force !== false) args.push("/F")
    const r = spawnSync("taskkill", args, { windowsHide: true, encoding: "utf8" })
    // taskkill 对已退出进程返回非 0（"not found"），属于正常情况
    return r.status === 0 || /not found|没有找到/i.test(`${r.stdout ?? ""}${r.stderr ?? ""}`)
  }

  // POSIX：优先杀进程组（Host 是组长），配置不存在时退化为杀单进程
  const signal = options.force === false ? "SIGTERM" : "SIGKILL"
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    try {
      process.kill(pid, signal)
      return true
    } catch {
      return false
    }
  }
}
