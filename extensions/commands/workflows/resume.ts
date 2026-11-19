/**
 * /workflows resume 子命令：任务级恢复入口（M6）
 *
 * 用法：
 *   /workflows resume <脚本路径|注册表名> [--tasks] [k=v...]
 *
 * 与 run 的差别：
 *   - 复用同一执行链（makeWorkflowTool）
 *   - 默认带 taskResume:true（按 TaskCheckpoint 复用已完成任务）
 *   - `--status` 只打印任务清单与状态，不执行
 *
 * 任务清单来源：<cwd>/.pi/workflows/tasks/<workflowId>.tasks.json
 */

import fs from "node:fs"
import path from "node:path"

import { TaskRegistry } from "../../../src/engine/governance/task-registry.js"
import { makeWorkflowTool, parseWorkflowsRunArgs } from "../../../src/tools/workflow-tools.js"
import { readWorkflowScript, loadRegistry } from "../../../src/engine/runtime/workflow-registry.js"
import { parseWorkflowScript } from "../../../src/engine/runtime/vm.js"
import type { Subcommand } from "./types.js"

const TASK_DIR = path.join(".pi", "workflows", "tasks")

function resolveWorkflowId(cwd: string, scriptPath: string): string | undefined {
  try {
    const registry = loadRegistry(cwd)
    const script = registry.has(scriptPath)
      ? readWorkflowScript(cwd, scriptPath)
      : fs.readFileSync(path.resolve(cwd, scriptPath), "utf-8")
    const meta = parseWorkflowScript(script).meta
    return meta.id ?? meta.name
  } catch {
    return undefined
  }
}

function renderTasks(dir: string, workflowId: string): string {
  const reg = new TaskRegistry({ dir: path.join(dir, TASK_DIR), workflowId })
  const tasks = reg.list()
  if (tasks.length === 0) return `任务清单为空：${path.join(TASK_DIR, `${workflowId}.tasks.json`)}（首次执行后生成）`
  const stats = reg.stats()
  const lines = [
    `任务清单：${workflowId}（共 ${tasks.length}）`,
    `  done ${stats.done} / failed ${stats.failed} / running ${stats.running} / pending ${stats.pending}`,
    "",
  ]
  for (const t of tasks.slice(0, 40)) {
    const dur = t.committedAt !== undefined ? `${Math.max(0, Math.round((t.committedAt - (t.updatedAt ?? t.committedAt)) / 1000))}s` : "-"
    lines.push(`  [${t.status}] ${t.taskKey}  gen=${t.leaseGeneration} attempt=${t.attempt} ${dur}${t.error ? `  err=${t.error.slice(0, 60)}` : ""}`)
  }
  if (tasks.length > 40) lines.push(`  …（其余 ${tasks.length - 40} 条省略）`)
  lines.push("", "可用 /workflows resume <脚本> --tasks 只重跑 failed/未完成任务")
  return lines.join("\n")
}

export const resumeSubcommand: Subcommand = {
  usage: "resume <路径|注册表名> [--tasks|--status] [k=v...]  任务级恢复（只重跑未完成任务）",
  async run(argv, ctx, deps) {
    const cwd = ctx.cwd ?? process.cwd()
    const showStatus = argv.includes("--status")
    const taskMode = argv.includes("--tasks") || showStatus
    const cleaned = argv.filter((a) => a !== "--tasks" && a !== "--status")
    const parsed = parseWorkflowsRunArgs(cleaned)
    if (parsed.error || !parsed.scriptPath) {
      ctx.ui.notify(parsed.error ?? "用法: /workflows resume <脚本路径|注册表名> [--tasks|--status] [key=value ...]", "warning")
      return
    }

    const workflowId = resolveWorkflowId(cwd, parsed.scriptPath)
    if (!workflowId) {
      ctx.ui.notify(`无法解析 workflowId（脚本不存在或缺少 meta）：${parsed.scriptPath}`, "warning")
      return
    }

    if (showStatus) {
      ctx.ui.notify(renderTasks(cwd, workflowId), "info")
      return
    }

    const tool = makeWorkflowTool({ ...deps.makeDeps(cwd), deliver: deps.deliver })
    const r = await tool.execute(
      "cmd",
      {
        scriptPath: parsed.scriptPath,
        args: parsed.args,
        background: true,
        ...(taskMode ? { taskResume: true } : {}),
      },
      undefined,
      undefined,
      ctx,
    )
    const text = (r as any).content[0].text
    ctx.ui.notify(`${text}\n任务级恢复：${taskMode ? "已启用（按 TaskCheckpoint 复用已完成任务）" : "未启用"}\n任务清单: /workflows resume ${parsed.scriptPath} --status`, "info")
    void deps
  },
}
