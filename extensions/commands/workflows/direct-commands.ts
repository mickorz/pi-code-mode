/**
 * workflow 注册表顶层斜杠命令直跑（/<workflowId>）。
 *
 * 注册时机：session_start（pi 的 registerCommand 必须在会话装配期调用，且宿主不支持注销命令）。
 * 注册条件：仅显式 manifest 模式（.pi/workflows/register.json）——legacy 目录扫描的存量脚本
 *          数量不可控，注册成顶层命令会污染斜杠补全；这类项目继续用 /workflows run <路径>。
 *
 * 执行链复用：handler 不解析脚本、不碰 RunManager，直接转发 makeWorkflowTool
 *            （scriptPath=workflowId, background=true），与 /workflows run 完全同链。
 *
 * 调用时求值：pi 无法注销已注册命令，unregister 后旧命令残留到会话重启。handler 每次触发
 *            实时重查 manifest，已注销则只提示、绝不执行（第三方 pi-dynamic-workflows 同款防护）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { loadManifest, loadRegistry } from "../../../src/engine/runtime/workflow-registry.js"
import { makeWorkflowTool, parseWorkflowsRunArgs } from "../../../src/tools/workflow-tools.js"
import type { WorkflowsCommandDeps } from "./types.js"

/**
 * pi 宿主内置斜杠命令保留名。
 *
 * 来源：pi-coding-agent 1.4.x 的 BUILTIN_SLASH_COMMANDS（dist/core/slash-commands.js，24 个公开名）
 * + interactive-mode.js 里 3 个直达处理器（debug / arminsayshi / dementedelves）。
 * 宿主未从包主入口导出该清单，只能本地维护；升级 pi 时需核对该常量。
 */
export const PI_RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "settings",
  "model",
  "tree",
  "thinking",
  "scoped-models",
  "export",
  "import",
  "share",
  "bug",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "reload",
  "resume",
  "quit",
  "debug",
  "arminsayshi",
  "dementedelves",
])

/** 本扩展已装配的顶层命令（pi-code-mode.ts 注册的三个） */
export const OWN_COMMAND_NAMES: ReadonlySet<string> = new Set(["workflows", "schedule", "explorer"])

/** 顶层命令可用名：首字符字母数字，其后字母数字/下划线/连字符，总长 1~64 */
const SAFE_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** 仅判定能否作为顶层斜杠命令使用；不影响 workflowId 本身的注册合法性 */
export function isDirectCommandSafeName(name: string): boolean {
  return SAFE_COMMAND_NAME.test(name)
}

/**
 * 命令名冲突检测。返回原因文案，undefined 表示可注册。
 * 注意：pi.getCommands() 不包含宿主内置命令（实测 1.4.x），故保留名清单不可省略。
 */
export function directCommandConflict(pi: ExtensionAPI, name: string): string | undefined {
  if (PI_RESERVED_COMMAND_NAMES.has(name)) return "是 pi 保留的命令名"
  if (OWN_COMMAND_NAMES.has(name)) return "与本扩展的固定命令重名"
  try {
    const taken = (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === name)
    if (taken) return "已被其他扩展或命令模板占用"
  } catch {
    // 命令列表不可用（早期装配期/宿主兼容面）：无法证实无冲突，拒绝注册
    return "无法读取已有命令列表，跳过冲突检测"
  }
  return undefined
}

export interface DirectCommandRegistration {
  /** 本次成功注册的顶层命令名 */
  registered: string[]
  /** 跳过的条目及原因（由调用方汇总展示） */
  skipped: string[]
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error)
}

/**
 * 生成 /<id> 的命令处理函数。
 * ctx.cwd 是唯一工作目录来源（resume/fork 跨项目时以会话真实项目为准）。
 */
function makeDirectHandler(id: string, deps: WorkflowsCommandDeps) {
  return async (args: string, ctx: any): Promise<void> => {
    const cwd = ctx.cwd ?? process.cwd()

    // 调用时求值：已注销则拒绝执行（宿主无法注销已注册命令）
    let exists = false
    try {
      exists = loadManifest(cwd) != null && loadRegistry(cwd).has(id)
    } catch (error) {
      ctx.ui.notify(`[/${id}] 读取 workflow 注册表失败: ${errorText(error)}`, "warning")
      return
    }
    if (!exists) {
      ctx.ui.notify(`workflow "${id}" 已注销（/${id} 命令残留到会话重启，重启后消失）`, "warning")
      return
    }

    const tokens = args.trim() ? args.trim().split(/\s+/) : []
    const parsed = parseWorkflowsRunArgs([id, ...tokens])
    if (parsed.error || !parsed.scriptPath) {
      ctx.ui.notify(parsed.error ?? `用法: /${id} [key=value ...]`, "warning")
      return
    }

    try {
      const tool = makeWorkflowTool({ ...deps.makeDeps(cwd), deliver: deps.deliver })
      const r = await tool.execute("cmd", { scriptPath: parsed.scriptPath, args: parsed.args, background: true }, undefined, undefined, ctx)
      ctx.ui.notify((r as any).content[0].text, "info")
    } catch (error) {
      ctx.ui.notify(`/${id} 执行失败: ${errorText(error)}`, "error")
    }
  }
}

/**
 * 把注册表内每个安全且无冲突的 workflowId 注册为顶层斜杠命令。
 * 只读 manifest 模式；不操作 UI（诊断交回调用方聚合提示），便于 fake pi 做无 UI contract 测试。
 */
export function registerWorkflowDirectCommands(
  pi: ExtensionAPI,
  deps: WorkflowsCommandDeps,
  cwd: string,
): DirectCommandRegistration {
  const skipped: string[] = []
  const registeredNames: string[] = []

  // legacy 目录扫描模式不注册（存量脚本数量不可控，避免污染补全）
  let hasManifest = false
  try {
    hasManifest = loadManifest(cwd) != null
  } catch (error) {
    return { registered: [], skipped: [`读取 workflow 注册表失败: ${errorText(error)}`] }
  }
  if (!hasManifest) return { registered: [], skipped: [] }

  let registry: Map<string, { name: string; description?: string }>
  try {
    registry = loadRegistry(cwd)
  } catch (error) {
    return { registered: [], skipped: [`读取 workflow 注册表失败: ${errorText(error)}`] }
  }

  for (const [id, workflow] of registry) {
    if (!isDirectCommandSafeName(id)) {
      skipped.push(`/${id}: 名称不适合作为顶层命令（限字母数字、下划线、连字符，且不以连字符开头）`)
      continue
    }
    const conflict = directCommandConflict(pi, id)
    if (conflict) {
      skipped.push(`/${id}: ${conflict}`)
      continue
    }
    try {
      pi.registerCommand(id, {
        description: `workflow: ${workflow.description || workflow.name}（等价 /workflows run ${id}）`,
        handler: makeDirectHandler(id, deps),
      })
      registeredNames.push(id)
    } catch (error) {
      skipped.push(`/${id}: 注册失败: ${errorText(error)}`)
    }
  }

  return { registered: registeredNames, skipped }
}
