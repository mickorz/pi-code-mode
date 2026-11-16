/**
 * /workflows register|reg 与 unregister|unreg 子命令。
 *
 * 注册表 = <项目>/.pi/workflows/register.json（配置统一收敛），脚本副本统一存 .pi/workflows/workflows/<id>.js：
 *   register   校验脚本（meta 信封）→ 副本落盘 → manifest 追加条目（id 冲突拒绝）
 *   unregister manifest 移除条目 + 删除副本；按 id 或副本文件名匹配
 *
 * 双模式边界（与 loadRegistry 对齐）：register.json 存在即排他（只能通过指令注册/移除，
 * 手工放置的文件不生效）；manifest 不存在时项目处于旧目录扫描模式，unregister 保留
 * 旧目录文件移除出口（含坏脚本按文件名删除、basename 钳制防路径逃逸）。
 */

import fs from "node:fs"
import path from "node:path"
import { parseWorkflowScript } from "../../../src/engine/runtime/vm.js"
import {
  addToManifest,
  loadManifest,
  loadRegistry,
  managedWorkflowsDir,
  removeFromManifest,
  workflowsDir,
  type ManifestEntry,
} from "../../../src/engine/runtime/workflow-registry.js"
import type { Subcommand } from "./types.js"

export const registerSubcommand: Subcommand = {
  usage: "register|reg <脚本路径>        注册工作流（校验后配置入 .pi/workflows/register.json）",
  async run(argv, ctx, _deps) {
    const cwd = ctx.cwd ?? process.cwd()
    if (!argv[0]) {
      ctx.ui.notify("用法: /workflows register <脚本路径>", "warning")
      return
    }
    const srcPath = path.resolve(cwd, argv[0])
    let script: string
    try {
      script = fs.readFileSync(srcPath, "utf-8")
    } catch (e) {
      ctx.ui.notify(`读取失败: ${srcPath}（${String((e as Error)?.message ?? e)}）`, "warning")
      return
    }
    let meta: { id?: string; name: string; description?: string }
    try {
      meta = parseWorkflowScript(script).meta
    } catch (e) {
      ctx.ui.notify(`脚本校验失败（未注册）: ${String((e as Error)?.message ?? e)}`, "warning")
      return
    }
    const workflowId = meta.id ?? meta.name
    // id 冲突检查：覆盖 manifest 与旧目录两种来源（注册动作阶段就报，不留到扫描/运行时炸）
    const existing = loadRegistry(cwd).get(workflowId)
    if (existing) {
      ctx.ui.notify(`workflowId "${workflowId}" 已被占用: ${existing.filePath}（改名 meta.id/meta.name 后重试）`, "warning")
      return
    }
    // 副本落盘：统一 .pi/workflows/workflows/<id>.js（file 字段存项目相对路径，/ 分隔利于跨机）
    const safeId = workflowId.replace(/[^\w.-]/g, "_")
    const storeRel = `.pi/workflows/workflows/${safeId}.js`
    const storeAbs = path.resolve(cwd, storeRel)
    if (fs.existsSync(storeAbs)) {
      ctx.ui.notify(`受管副本已存在: ${storeAbs}（重命名 meta.id 或先 unregister）`, "warning")
      return
    }
    fs.mkdirSync(path.dirname(storeAbs), { recursive: true })
    fs.copyFileSync(srcPath, storeAbs)
    const entry: ManifestEntry = {
      id: workflowId,
      name: meta.name,
      description: meta.description,
      file: storeRel,
      sourcePath: srcPath,
      registeredAt: new Date().toISOString(),
    }
    try {
      addToManifest(cwd, entry)
    } catch (e) {
      // manifest 写入失败回滚副本，不留孤儿文件
      fs.unlinkSync(storeAbs)
      ctx.ui.notify(`注册失败: ${String((e as Error)?.message ?? e)}`, "warning")
      return
    }
    ctx.ui.notify(`已注册 workflow "${workflowId}"（配置 ${path.resolve(cwd, ".pi/workflows/register.json")}）；/workflows list 查看，执行用 /workflows run ${workflowId}`, "info")
  },
}

export const unregisterSubcommand: Subcommand = {
  usage: "unregister|unreg <id|文件名>   注销工作流（从 register.json 与受管目录移除）",
  async run(argv, ctx, _deps) {
    const cwd = ctx.cwd ?? process.cwd()
    if (!argv[0]) {
      ctx.ui.notify("用法: /workflows unregister <workflowId 或文件名>", "warning")
      return
    }
    const key = argv[0]

    // manifest 模式：按 id 或副本文件名移除条目 + 副本
    if (loadManifest(cwd)) {
      const known = () =>
        loadManifest(cwd)!
          .workflows.map((w) => w.id)
          .join(", ") || "（注册表为空）"
      const entry =
        loadManifest(cwd)!.workflows.find((w) => w.id === key) ??
        loadManifest(cwd)!.workflows.find((w) => path.basename(w.file) === path.basename(key))
      if (!entry) {
        ctx.ui.notify(`未找到 workflow "${key}"（已知 id：${known()}）`, "warning")
        return
      }
      removeFromManifest(cwd, entry.id)
      const storeAbs = path.resolve(cwd, entry.file)
      if (fs.existsSync(storeAbs)) fs.unlinkSync(storeAbs)
      ctx.ui.notify(`已注销 workflow "${entry.id}"（manifest 条目与副本 ${storeAbs} 均已移除）`, "info")
      return
    }

    // fallback 模式（旧目录扫描，无 manifest）：按文件名（basename 钳制在注册目录内，防路径逃逸）
    // 优先删除；按 id 匹配走逐文件解析（坏脚本无 id 可匹配，按文件名删除仍是出口）
    const targetDir = workflowsDir(cwd)
    let targetPath = path.join(targetDir, path.basename(key))
    if (!fs.existsSync(targetPath)) {
      const parseFailures: string[] = []
      targetPath = ""
      if (fs.existsSync(targetDir)) {
        for (const name of fs.readdirSync(targetDir)) {
          if (!name.endsWith(".js")) continue
          const filePath = path.join(targetDir, name)
          try {
            const { meta } = parseWorkflowScript(fs.readFileSync(filePath, "utf-8"))
            if ((meta.id ?? meta.name) === key) {
              targetPath = filePath
              break
            }
          } catch (e) {
            parseFailures.push(`${name}: ${String((e as Error)?.message ?? e).slice(0, 80)}`)
          }
        }
      }
      if (!targetPath) {
        const lines = [`未找到 workflow "${key}"（按文件名与 workflowId 均未命中）`]
        if (parseFailures.length) lines.push(`其中无法按 id 匹配的坏脚本（可按文件名删除）:\n  ${parseFailures.join("\n  ")}`)
        ctx.ui.notify(lines.join("\n"), "warning")
        return
      }
    }
    fs.unlinkSync(targetPath)
    ctx.ui.notify(`已注销 workflow（已移除 ${targetPath}）`, "info")
  },
}
