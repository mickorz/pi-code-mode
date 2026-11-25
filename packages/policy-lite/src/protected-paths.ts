/**
 * 受保护路径清单（M1 最小集，参照 PiBot protected-paths.ts 清单结构）
 *
 * M1 消费方：command-analysis 的危险命令判定（命令文本指向受保护路径的写入/删除）。
 * 文件工具的路径边界由 execution/files/path-boundary 强制（工作区外一律拒绝），
 * 本清单在此之外再拦"工作区内路径被符号链接指向系统区"等分析层风险。
 */

import path from "node:path"

/** 系统目录（写入/删除即危险；平台无关清单 + 平台分支） */
export const SYSTEM_DIRS: readonly string[] = [
  "/System",
  "/Library",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/private",
  "/Applications",
  "/boot",
  "/lib",
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/snap",
]

/** Windows 系统目录名（匹配路径任一段） */
export const WINDOWS_SYSTEM_SEGMENTS: readonly string[] = [
  "Windows",
  "Program Files",
  "Program Files (x86)",
  "ProgramData",
]

/** 凭据目录（家目录下；读写都算危险） */
export const CREDENTIAL_DIRS: readonly string[] = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".config/gcloud",
]

/** 目标路径是否落在受保护树内（宽松匹配：命令文本里的路径不做 canonicalize，宁可误拦） */
export function isProtectedPath(target: string): boolean {
  const normalized = target.replace(/\\/g, "/")
  const lower = normalized.toLowerCase()
  // POSIX 绝对路径直接比对系统目录前缀
  if (normalized.startsWith("/")) {
    return SYSTEM_DIRS.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`))
  }
  // 盘符路径（C:/...）：检查 Windows 系统段
  if (/^[a-z]:\//i.test(normalized)) {
    const noDrive = normalized.slice(2)
    return WINDOWS_SYSTEM_SEGMENTS.some(
      (seg) => noDrive === `/${seg}` || noDrive.startsWith(`/${seg}/`),
    )
  }
  // 家目录相对的凭据目录（~/xxx 或 .ssh 形态）
  const stripped = lower.startsWith("~/") ? lower.slice(2) : lower
  return CREDENTIAL_DIRS.some(
    (dir) => stripped === dir || stripped.startsWith(`${dir}/`),
  )
}

/** 系统设备/危险设备目标（/dev/null 除外：它是指定输出的合法排洪口） */
export function isDeviceTarget(target: string): boolean {
  const normalized = target.replace(/\\/g, "/")
  if (normalized === "/dev/null") return false
  return /^\/dev\/(sd|nvme|hd|disk|mapper|mem|kmem)/.test(normalized)
}
