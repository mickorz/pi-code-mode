/**
 * 工作区路径规范化（M2-W2）
 *
 * 目的：让"E:\Projects\Game-A" 与 "e:\projects\game-a\"、"E:\Proj\..\Projects\Game-A"、
 * 经由 junction/symlink 的等价路径，得到同一个比较键。否则 deny 列表可被轻易绕过。
 *
 * 两个概念必须分开：
 *   canonicalKey —— **仅用于比较**（Windows 小写化 + 分隔符统一 + 去尾分隔符）
 *   realPath     —— **交给 MXC 的实际路径**（大小写保持原样，symlink 已解到真实位置）
 * 混用会导致：把全小写路径喂给 MXC 在大小写敏感语义下不匹配真实目录。
 */

import { realpathSync } from "node:fs"
import path from "node:path"

export interface NormalizedWorkspacePath {
  /** 显示/传递用（解析相对路径 + 消解 symlink，保持原始大小写） */
  realPath: string
  /** 比较用键（Windows 小写化，统一分隔符，无尾分隔符） */
  canonicalKey: string
}

/** 比较键：Windows 不区分大小写，统一为小写 + '/' 分隔 + 无尾部斜杠 */
export function canonicalKeyOf(absolutePath: string, platform: NodeJS.Platform = process.platform): string {
  const unified = absolutePath.replace(/\\/g, "/")
  const trimmed = unified.length > 1 ? unified.replace(/\/+$/, "") : unified
  return platform === "win32" ? trimmed.toLowerCase() : trimmed
}

/**
 * 规范化一条工作区路径。
 * realPath：先 resolve 成绝对路径，若存在则 realpath（消解 symlink / junction），否则保留 resolve 结果。
 * 解析失败（权限、路径中含 null 字节等）→ 抛错。**不静默降级**：调用方必须 fail-closed。
 */
export function normalizeWorkspacePath(
  target: string,
  options: { base?: string; platform?: NodeJS.Platform } = {},
): NormalizedWorkspacePath {
  const platform = options.platform ?? process.platform
  if (typeof target !== "string" || !target.trim()) {
    throw new Error("工作区路径为空")
  }
  if (target.includes("\0")) {
    throw new Error("工作区路径含非法字符")
  }
  const absolute = path.isAbsolute(target) ? target : path.resolve(options.base ?? process.cwd(), target)
  let realPath: string
  try {
    realPath = realpathSync.native(absolute)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // 不存在 → 向上找**最近存在的祖先**解 realpath，再拼回剩余段；
    // 不能只 path.resolve：Windows 下同一目录的短名/长名会得到不同比较键，嵌套路径就漏判。
    if (code === "ENOENT" || code === "ENOTDIR") {
      realPath = canonicalizeViaExistingAncestor(absolute)
    } else {
      // 其它错误（权限等）→ 抛错不降级
      throw new Error(`工作区路径解析失败（${code ?? "unknown"}）：${target}`)
    }
  }
  realPath = path.normalize(realPath)
  return { realPath, canonicalKey: canonicalKeyOf(realPath, platform) }
}

/** 向上找到最近存在的祖先并 realpath，再拼回未存在的尾段 */
function canonicalizeViaExistingAncestor(absolute: string): string {
  let current = absolute
  const suffix: string[] = []
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...suffix.reverse())
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new Error(`工作区路径解析失败（${code ?? "unknown"}）：${absolute}`)
      }
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(absolute) // 到根仍不存在
      suffix.push(path.basename(current))
      current = parent
    }
  }
}

/** a 是否等于 b 或位于 b 之内（基于比较键；含等于） */
export function isAtOrUnder(childKey: string, parentKey: string, platform: NodeJS.Platform = process.platform): boolean {
  if (childKey === parentKey) return true
  const sep = platform === "win32" ? "/" : "/"
  const parent = parentKey.endsWith(sep) ? parentKey : `${parentKey}${sep}`
  return childKey.startsWith(parent)
}
