/**
 * 路径边界 —— 工作区文件访问的强制防线（M1）
 *
 * 所有文件工具的目标路径必须落在 workspace root 内（canonicalize 后比对），
 * 符号链接先解到真实路径再判定，防 symlink 逃逸。
 * 目标不存在时以父目录链 canonicalize（新文件的写入边界 = 其最近存在父目录）。
 */

import { realpath } from "node:fs/promises"
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

/** 只读判定用（存在性检查前先过边界） */
export async function assertWithin(root: string, target: string): Promise<void> {
  await resolveWithin(root, target)
}
