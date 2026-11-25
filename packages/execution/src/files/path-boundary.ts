/**
 * 路径边界 —— 工作区文件访问的强制防线（M1.1 + M1.2 加固）
 *
 * 边界判定：目标 canonicalize（realpath 消解 symlink）后必须落在 workspace root 内。
 *
 * TOCTOU 防护（M1.2，评审 P0 修复）：
 *   窗口：lstat 检查(T1) -> 内核 open(T2) 之间，攻击者把目标换成指向外部的 symlink。
 *   防护三层：
 *   1. 打开前 lstat：最终组件是 symlink -> 立即拒绝；
 *   2. open 带 O_NOFOLLOW（Linux/macOS）：内核层拒绝最终组件 symlink，T1..T2 窗口内
 *      被换成 symlink 时 open 直接 ELOOP 失败（不跟随，不是事后才检查）；
 *   3. fstat(fd) 与 **打开前保存的 lstat 结果** 比对 dev+ino（M1.2 修正：M1.1 误用
 *      open 后重新 stat(real)——攻击者替换后两侧都是外部文件，校验恒通过，形同虚设）。
 *   新建文件用 O_CREAT|O_EXCL（"wx"）：最终组件是 symlink 时内核不跟随。
 *
 *   残余风险（如实声明）：中间目录整链在 T1..T2 被替换的窗口仍在（Node 无 openat）；
 *   该风险由「FileService 拒绝 symlink 最终组件」与 M2 沙盒策略共同收窄，
 *   OS 级完整路径隔离需 M2 SRT（注意：SRT 只约束子进程，不保护宿主进程内的本服务）。
 */

import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"

export class PathBoundaryError extends Error {
  constructor(
    readonly target: string,
    readonly reason: string,
  ) {
    super(`路径越界（${reason}）: ${target}`)
    this.name = "PathBoundaryError"
  }
}

/** canonicalize 一条可能不存在的路径：向上找最近存在的祖先，解 realpath 后拼回剩余段 */
async function canonicalize(target: string): Promise<string> {
  const absolute = path.resolve(target)
  let current = absolute
  const suffix: string[] = []
  for (;;) {
    try {
      return path.join(await realpath(current), ...suffix.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return absolute // 到根都不存在：保持 resolve 结果
      suffix.push(path.basename(current))
      current = parent
    }
  }
}

/** 判定 target（canonicalize 后）是否落在 root（canonicalize 后）内（含等于） */
export async function resolveWithin(root: string, target: string): Promise<string> {
  const rootReal = await canonicalize(root)
  const targetReal = await canonicalize(target)
  const rel = path.relative(rootReal, targetReal)
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return targetReal
  throw new PathBoundaryError(target, "outside_workspace")
}

/**
 * 测试/攻击模拟钩子（仅 openWithin 内部使用）：在 lstat 检查通过、实际 open 之前调用，
 * 用于确定性地模拟"检查后替换"竞争窗口。生产路径不传。
 */
export interface OpenWithinHooks {
  beforeOpen?: (realPath: string) => void | Promise<void>
}

/** Windows 无 O_NOFOLLOW 语义（且 file symlink 需特权）；有则用于内核层拒绝最终组件 symlink */
const O_NOFOLLOW = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)

/**
 * 安全打开（M1.2）：
 *   1. resolveWithin 边界判定
 *   2. 打开前 lstat：最终组件是 symlink -> 拒绝
 *   3. open 带 O_NOFOLLOW（非 Windows）：
 *      - "read"：O_RDONLY
 *      - "edit"：O_RDWR
 *      - "create"：O_CREAT|O_EXCL|O_WRONLY（wx：不跟随最终 symlink，不覆盖已有文件）
 *   4. fstat(fd) 与打开前 lstat 的 dev+ino 比对，不一致 -> 关闭并拒绝
 * 返回 FileHandle（调用方负责 close；从 fd 读写，不再走路径解析）。
 */
export async function openWithin(
  root: string,
  target: string,
  mode: "read" | "edit" | "create",
  hooks: OpenWithinHooks = {},
): Promise<FileHandle> {
  const real = await resolveWithin(root, target)
  const before = await lstat(real).catch(() => undefined)
  if (before?.isSymbolicLink()) {
    throw new PathBoundaryError(target, "symlink_final_component")
  }
  if (mode === "create" && before) {
    throw new PathBoundaryError(target, "already_exists_for_create")
  }
  if (mode !== "create" && !before) {
    throw new PathBoundaryError(target, "not_found")
  }

  // 攻击模拟注入点：此处到 open 之间即真实竞争窗口
  await hooks.beforeOpen?.(real)

  const baseFlags =
    mode === "create"
      ? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
      : mode === "edit"
        ? constants.O_RDWR
        : constants.O_RDONLY
  let handle: FileHandle
  try {
    handle = await open(real, baseFlags | O_NOFOLLOW)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // ELOOP（O_NOFOLLOW 命中 symlink）/ EEXIST（create 竞争）/ ENOENT（被删除）
    throw new PathBoundaryError(
      target,
      code === "ELOOP"
        ? "symlink_race_blocked"
        : code === "EEXIST"
          ? "create_race"
          : code === "ENOENT"
            ? "vanished_after_check"
            : "open_failed",
    )
  }

  // M1.2 修正：与**打开前**的 lstat 比对（M1.1 比对 open 后的 stat(real) 无效）
  if (mode === "create") {
    // create 场景：打开前必须不存在，新建的 inode 无需比对（已由 O_EXCL 保证全新文件）
    return handle
  }
  const opened = await handle.stat()
  if (!before || opened.dev !== before.dev || opened.ino !== before.ino) {
    await handle.close()
    throw new PathBoundaryError(target, "replaced_after_check")
  }
  return handle
}

/** 只读判定用（存在性检查前先过边界） */
export async function assertWithin(root: string, target: string): Promise<void> {
  await resolveWithin(root, target)
}
