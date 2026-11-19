/**
 * 用系统默认浏览器打开本地文件
 *
 * 平台命令：
 *  - Windows: cmd /c start "" "<file url>"（空 title 占位是必需的，否则首个引号会被当成窗口标题）
 *  - macOS:   open "<path>"
 *  - Linux:   xdg-open "<path>"
 *
 * 设计：只返回结果不抛错——报告文件已经生成并打印了路径，打开失败不该让命令报错。
 * 非交互环境（CI / 无 TTY）由调用方决定是否跳过，本模块不猜测。
 */
import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

export interface OpenResult {
  ok: boolean
  error?: string
}

/** 构造打开命令（纯函数，便于无副作用测试） */
export function openCommandFor(filePath: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  const abs = path.resolve(filePath)
  if (platform === "win32") {
    // 不用 `cmd /c start`：它会把 file:// URL 当路径去找，中文路径的 %XX 编码直接报
    // 「系统找不到文件」并弹窗。explorer 直接收绝对路径，execFile 负责引号转义。
    return { cmd: "explorer", args: [abs] }
  }
  if (platform === "darwin") return { cmd: "open", args: [abs] }
  return { cmd: "xdg-open", args: [abs] }
}

/** 是否应该自动打开：CI 或显式关闭时跳过 */
export function shouldAutoOpen(env: NodeJS.ProcessEnv = process.env): { open: boolean; reason?: string } {
  if (env.CI === "1" || env.CI === "true") return { open: false, reason: "CI 环境" }
  if (env.PI_NO_BROWSER === "1") return { open: false, reason: "PI_NO_BROWSER=1" }
  return { open: true }
}

export function openInBrowser(filePath: string, platform: NodeJS.Platform = process.platform): Promise<OpenResult> {
  const abs = path.resolve(filePath)
  // explorer 即使路径不存在也只返回 1（与成功同码），所以先自己校验存在性
  if (!fs.existsSync(abs)) return Promise.resolve({ ok: false, error: `文件不存在：${abs}` })
  const { cmd, args } = openCommandFor(abs, platform)
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err) => {
      if (!err) return resolve({ ok: true })
      // explorer.exe 即使成功打开也常返回退出码 1；只有“找不到可执行文件”才算真失败
      const code = (err as NodeJS.ErrnoException).code
      if (platform === "win32" && code !== "ENOENT") return resolve({ ok: true })
      resolve({ ok: false, error: String(err.message ?? err) })
    })
  })
}
