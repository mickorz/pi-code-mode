/**
 * /workflows list 子命令：列出注册表工作流与最近运行（含全部 runId）。
 * 注册表来自 .pi/workflows/（及兼容目录），最近运行来自 RunManager 快照。
 */

import { loadRegistry } from "../../../src/engine/runtime/workflow-registry.js"
import type { Subcommand } from "./types.js"

export const listSubcommand: Subcommand = {
  usage: "list                        列出注册表工作流与最近运行（含全部 runId）",
  async run(_argv, ctx, deps) {
    const cwd = ctx.cwd ?? process.cwd()
    const lines: string[] = []
    try {
      const registry = loadRegistry(cwd)
      if (registry.size) {
        lines.push(`已注册工作流（${registry.size}，来源 .pi/workflows/register.json 或兼容目录扫描）:`)
        for (const [id, wf] of registry) lines.push(`  - ${id}  ${wf.description ?? ""}`)
      } else {
        lines.push("注册表为空（项目内未发现可注册的 workflow 脚本）")
      }
    } catch (e) {
      lines.push(`注册表读取失败: ${String((e as Error)?.message ?? e)}`)
    }
    const runs = deps.runManager.list()
    lines.push("")
    lines.push(runs.length ? `最近运行（${runs.length}）:` : "最近无 workflow 运行")
    for (const r of runs) {
      lines.push(
        `  - ${r.status.padEnd(9)} ${r.runId}${r.label ? `（${r.label}）` : ""} agents=${r.agents}${r.error ? ` 错误: ${r.error.slice(0, 60)}` : ""}`,
      )
    }
    ctx.ui.notify(lines.join("\n"), "info")
  },
}
