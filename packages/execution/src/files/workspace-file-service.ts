/**
 * WorkspaceFileService —— Agent 文件工具的唯一执行出口（M1 + M1.1 加固）
 *
 * read_file / write_file / edit_file 全部经此服务：
 *   路径边界：openWithin（canonicalize + 工作区边界 + symlink 最终组件拒绝 + dev/ino 复核）
 *   写入语义：全部从 FileHandle（fd）读写，打开后不再走路径解析（TOCTOU 收口）
 * Permit 校验在 agent-tools 层（第二阶段防线），本层管边界强制与文件语义。
 */

import { FileHandle } from "node:fs/promises"
import path from "node:path"
import { PathBoundaryError, openWithin } from "./path-boundary.js"

/** 单文件读取上限（1MB：防巨文件撑爆上下文；超限错误信息指引用户分段读） */
const MAX_READ_BYTES = 1024 * 1024

export class WorkspaceFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkspaceFileError"
  }
}

export interface EditOutcome {
  path: string
  /** 完成替换的匹配次数（edit 语义要求恰好 1 次） */
  replacements: number
}

export class WorkspaceFileService {
  constructor(readonly root: string) {}

  private resolve(target: string): string {
    // 相对路径以 root 为基（openWithin 内部再做 canonicalize + 边界）
    return path.isAbsolute(target) ? target : path.resolve(this.root, target)
  }

  async read(target: string, signal?: AbortSignal): Promise<string> {
    const handle: FileHandle = await openWithin(this.root, this.resolve(target), "read")
    try {
      const st = await handle.stat()
      if (st.size > MAX_READ_BYTES) {
        throw new WorkspaceFileError(`文件超过读取上限（${st.size} > ${MAX_READ_BYTES} 字节）: ${target}`)
      }
      const buffer = await handle.readFile({ signal })
      return buffer.toString("utf8")
    } finally {
      await handle.close()
    }
  }

  async write(target: string, content: string, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolve(target)
    // 两段式：存在则 r+ 改写；不存在则 wx 原子创建（防创建竞争，见 openWithin 注释）
    let handle: FileHandle
    try {
      handle = await openWithin(this.root, resolved, "edit")
    } catch (e) {
      if (e instanceof PathBoundaryError && e.reason === "not_found") {
        handle = await openWithin(this.root, resolved, "create")
      } else {
        throw e
      }
    }
    try {
      // fd 写入必须显式 position 0：fd 的当前位置可能不为 0（readFile 后会推到尾部）
      await handle.write(content, 0, "utf8")
      await handle.truncate(content.length)
    } finally {
      await handle.close()
    }
  }

  /**
   * 精确替换：oldText 必须在文件中恰好出现一次（与 Claude edit 工具同语义）。
   * 0 次或多次都拒绝执行，避免模型在歧义位置静默改错。
   */
  async edit(target: string, oldText: string, newText: string, signal?: AbortSignal): Promise<EditOutcome> {
    if (!oldText) throw new WorkspaceFileError("edit 的 oldText 不能为空")
    const resolved = this.resolve(target)
    // 读与写共用同一 FileHandle（r+）：读检查与写入之间不存在路径重解析窗口
    const handle = await openWithin(this.root, resolved, "edit")
    try {
      const content = await handle.readFile({ encoding: "utf8", signal })
      const first = content.indexOf(oldText)
      if (first === -1) {
        throw new WorkspaceFileError(`edit 失败：oldText 在 ${target} 中未找到`)
      }
      if (content.indexOf(oldText, first + 1) !== -1) {
        throw new WorkspaceFileError(`edit 失败：oldText 在 ${target} 中出现多次（要求唯一匹配）`)
      }
      const next = content.slice(0, first) + newText + content.slice(first + oldText.length)
      // 同一 fd 上读后写：显式 position 0（fd 当前位置在文件尾，否则会追加写）
      await handle.write(next, 0, "utf8")
      await handle.truncate(next.length)
      return { path: resolved, replacements: 1 }
    } finally {
      await handle.close()
    }
  }
}

export { PathBoundaryError }
