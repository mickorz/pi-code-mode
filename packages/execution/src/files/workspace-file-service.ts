/**
 * WorkspaceFileService —— Agent 文件工具的唯一执行出口（M1）
 *
 * read_file / write_file / edit_file 全部经此服务：路径先过 path-boundary
 * （canonicalize + 工作区边界），再触盘。Permit 校验在 agent-tools 层（第二阶段防线），
 * 本层管边界强制与文件语义。
 */

import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { PathBoundaryError, resolveWithin } from "./path-boundary.js"

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

  private resolve(target: string): Promise<string> {
    return resolveWithin(this.root, path.isAbsolute(target) ? target : path.resolve(this.root, target))
  }

  async read(target: string): Promise<string> {
    const real = await this.resolve(target)
    const buffer = await readFile(real)
    if (buffer.byteLength > MAX_READ_BYTES) {
      throw new WorkspaceFileError(
        `文件超过读取上限（${buffer.byteLength} > ${MAX_READ_BYTES} 字节）: ${target}`,
      )
    }
    return buffer.toString("utf8")
  }

  async write(target: string, content: string): Promise<void> {
    const real = await this.resolve(target)
    await writeFile(real, content, "utf8")
  }

  /**
   * 精确替换：oldText 必须在文件中恰好出现一次（与 Claude edit 工具同语义）。
   * 0 次或多次都拒绝执行，避免模型在歧义位置静默改错。
   */
  async edit(target: string, oldText: string, newText: string): Promise<EditOutcome> {
    if (!oldText) throw new WorkspaceFileError("edit 的 oldText 不能为空")
    const real = await this.resolve(target)
    const content = await readFile(real, "utf8")
    const first = content.indexOf(oldText)
    if (first === -1) {
      throw new WorkspaceFileError(`edit 失败：oldText 在 ${target} 中未找到`)
    }
    if (content.indexOf(oldText, first + 1) !== -1) {
      throw new WorkspaceFileError(`edit 失败：oldText 在 ${target} 中出现多次（要求唯一匹配）`)
    }
    await writeFile(real, content.slice(0, first) + newText + content.slice(first + oldText.length), "utf8")
    return { path: real, replacements: 1 }
  }
}

export { PathBoundaryError }
