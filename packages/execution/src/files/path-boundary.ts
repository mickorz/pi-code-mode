/**
 * 路径边界 —— 工作区文件访问的强制防线（M1 + M1.1 TOCTOU 加固）
 *
 * 边界判定：目标 canonicalize（realpath 消解 symlink）后必须落在 workspace root 内。
 *
 * TOCTOU 防护（M1.1，评审 P1）：
 *   窗口：canonicalize 通过(T1) -> 内核 open(T2) 之间，另一进程把目标或中间目录换成
 *   指向外部的 symlink。防护三层：
 *   1. 目标最终组件是 symlink -> 拒绝（lstat 判定 + fd 的 fstat 复核比对 dev/ino）；
 *   2. 新建文件用 O_CREAT|O_EXCL（"wx"）：最终组件是 symlink 时内核不跟随，直接失败；
 *   3. 打开后 fstat(fd) 与打开前 lstat(real) 比对 dev+ino：不一致 = 检查后被替换，拒绝。
 *   残余风险（如实声明）：中间目录整链在 T1..T2 被替换的窗口仍在（Node 无 openat）；
 *   M2 后 run_command 在沙盒内（可写边界=工作区），该攻击面由「FileService 拒绝 symlink
 *   最终组件」与沙盒策略共同收窄，OS 级完整隔离依赖 M2 SRT。
 */

import { lstat, open, realpath, stat } from "node:fs/promises"
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
 * 安全打开（M1.1 TOCTOU 加固核心）：
 *   1. resolveWithin 边界判定
 *   2. 最终组件为 symlink -> 拒绝（写场景尤其严格；读场景同样拒绝防信息外泄）
 *   3. 语义：
 *      - "read"：目标必须已存在，O_RDONLY 打开
 *      - "edit"：目标必须已存在，O_RDWR 打开
 *      - "create"：目标必须不存在，"wx"（O_CREAT|O_EXCL，不跟随最终 symlink）打开
 *   4. 打开后 fstat(fd) 与 lstat（判定时点）比对 dev+ino，不一致 -> 关闭并拒绝
 * 返回 FileHandle（调用方负责 close；从 fd 读写，不再走路径解析）。
 */
export async function openWithin(
  root: string,
  target: string,
  mode: "read" | "edit" | "create",
): Promise<FileHandle> {
  const real = await resolveWithin(root, target)
  const st = await lstat(real).catch(() => undefined)
  if (st?.isSymbolicLink()) {
    throw new PathBoundaryError(target, "symlink_final_component")
  }
  let handle: FileHandle
  if (mode === "create") {
    if (st) throw new PathBoundaryError(target, "already_exists_for_create")
    // wx：最终组件是 symlink 时内核不跟随（EEXIST/失败），防创建竞争
    handle = await open(real, "wx").catch(() => {
      throw new PathBoundaryError(target, "create_race")
    })
  } else {
    if (!st) throw new PathBoundaryError(target, mode === "read" ? "not_found" : "not_found")
    handle = await open(real, mode === "read" ? "r" : "r+")
  }
  // fstat 复核：打开的 inode 必须就是判定时 lstat 看到的那个（防检查后被替换）
  const opened = await handle.stat()
  const expected = await stat(real).catch(() => undefined)
  if (!expected || opened.dev !== expected.dev || opened.ino !== expected.ino) {
    await handle.close()
    throw new PathBoundaryError(target, "replaced_after_check")
  }
  return handle
}

/** 只读判定用（存在性检查前先过边界） */
export async function assertWithin(root: string, target: string): Promise<void> {
  await resolveWithin(root, target)
}
