/**
 * /workflows list 子命令：列出工作流与最近运行（含全部 runId）。
 * 来源两处：项目注册表（.pi/workflows/register.json 或兼容目录扫描）与随包内置（包根 workflows/）。
 * 最近运行来自 RunManager 快照。
 */

import { loadRegistry } from "../../../../../packages/engine/src/runtime/workflow-registry.js"
import type { Subcommand } from "./types.js"

export const listSubcommand: Subcommand = {
  usage: "list                        列出注册表工作流与最近运行（含全部 runId）",
  async run(_argv, ctx, deps) {
    const cwd = ctx.cwd ?? process.cwd()
    const lines: string[] = []
    try {
      const registry = loadRegistry(cwd)
      const builtin = [...registry.values()].filter((wf) => wf.builtin)
      const project = [...registry.values()].filter((wf) => !wf.builtin)
      if (project.length) {
        lines.push(`项目注册（${project.length}，来源 .pi/workflows/register.json 或兼容目录扫描）:`)
        for (const wf of project) lines.push(`  - ${wf.id}  ${wf.description ?? ""}`)
      } else {
        lines.push("项目注册：无（/workflows register <脚本路径> 注册项目内脚本）")
      }
      if (builtin.length) {
        lines.push(`内置（${builtin.length}，随包分发，无需注册）:`)
        for (const wf of builtin) lines.push(`  - ${wf.id}  ${wf.description ?? ""}`)
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
