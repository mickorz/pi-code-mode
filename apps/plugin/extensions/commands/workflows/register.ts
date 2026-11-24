/**
 * /workflows register|reg 与 unregister|unreg 子命令。
 *
 * 注册表 = <项目>/.pi/workflows/register.json（配置统一收敛）；注册不复制脚本，脚本保持原位，
 * manifest 只记录其路径（file：项目相对优先、绝对兑底；源文件移动/删除后需重新 register）。
 *   register   校验脚本（meta 信封）→ id 冲突检查 → manifest 追加条目
 *   unregister  manifest 移除条目；按 id 或原位路径 basename 匹配
 *
 * 双模式边界（与 loadRegistry 对齐）：register.json 存在即排他（只能通过指令注册/移除，
 * 手工放置的文件不生效）；manifest 不存在时项目处于旧目录扫描模式，unregister 保留
 * 旧目录文件移除出口（含坏脚本按文件名删除、basename 钳制防路径逃逸）。
 */

import fs from "node:fs"
import path from "node:path"
import { parseWorkflowScript } from "../../../../../packages/engine/src/runtime/vm.js"
import {
  addToManifest,
  loadManifest,
  loadRegistry,
  removeFromManifest,
  workflowsDir,
  type ManifestEntry,
} from "../../../../../packages/engine/src/runtime/workflow-registry.js"
import type { Subcommand } from "./types.js"
import { isDirectCommandSafeName } from "./direct-commands.js"

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
      const reason = existing.builtin
        ? `是内置 workflow 的保留 id（${existing.filePath}，无需注册也不能同名覆盖）`
        : `已被占用: ${existing.filePath}`
      ctx.ui.notify(`workflowId "${workflowId}" ${reason}（改名 meta.id/meta.name 后重试）`, "warning")
      return
    }
    // 不复制：脚本保持原位，file 记录原位路径（项目相对优先，绝对兑底，/ 分隔利于跨机）
    const rel = path.relative(cwd, srcPath)
    const fileField = path.isAbsolute(rel) || rel.startsWith("..") ? srcPath : rel.replace(/\\/g, "/")
    const entry: ManifestEntry = {
      id: workflowId,
      name: meta.name,
      description: meta.description,
      file: fileField,
      registeredAt: new Date().toISOString(),
    }
    try {
      addToManifest(cwd, entry)
    } catch (e) {
      ctx.ui.notify(`注册失败: ${String((e as Error)?.message ?? e)}`, "warning")
      return
    }
    ctx.ui.notify(
      `已注册 workflow "${workflowId}"（配置 ${path.resolve(cwd, ".pi/workflows/register.json")}，脚本保持原位 ${srcPath}）。` +
        (isDirectCommandSafeName(workflowId)
          ? `重启会话后可直接 /${workflowId} [k=v...] 直跑，当前会话请用 /workflows run ${workflowId}`
          : `该 id 不适合作为顶层命令（限字母数字、下划线、连字符），执行用 /workflows run ${workflowId}`) +
        `；移动或删除源文件后需重新 register，/workflows list 查看`,
      "info",
    )
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
        const builtin = loadRegistry(cwd).get(key)?.builtin
        ctx.ui.notify(
          builtin
            ? `"${key}" 是内置 workflow（随包分发，无需注册也不可注销）；如要改用自定义实现，换个 meta.id 注册`
            : `未找到 workflow "${key}"（已知 id：${known()}）`,
          "warning",
        )
        return
      }
      removeFromManifest(cwd, entry.id)
      ctx.ui.notify(
        `已注销 workflow "${entry.id}"（已从 register.json 移除，原位脚本 ${path.resolve(cwd, entry.file)} 保留不动）。` +
          `/${entry.id} 顶层命令无法在会话内移除（宿主限制）：本会话再输入只会提示已注销，重启会话后从补全列表消失`,
        "info",
      )
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
