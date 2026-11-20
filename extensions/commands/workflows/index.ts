/**
 * /workflows 斜杠命令入口与路由（子命令实现见同目录各文件）。
 *
 * 分发规则：
 *   - 无参数            -> 帮助面板（由路由表 usage 行汇总生成）
 *   - 已知子命令        -> 转发剩余 argv
 *   - 未知子命令        -> 警告 + 帮助
 *
 * 新增子命令：在目录内新建文件导出 Subcommand，加入下方路由表即可。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { runSubcommand } from "./run.js"
import { resumeSubcommand } from "./resume.js"
import { analyzeSubcommand, planSubcommand } from "./analyze.js"
import { listSubcommand } from "./list.js"
import { statusSubcommand } from "./status.js"
import { cancelSubcommand } from "./cancel.js"
import { registerSubcommand, unregisterSubcommand } from "./register.js"
import { uiSubcommand } from "./navigator/index.js"
import { watchSubcommand } from "./watch.js"
import { completeWorkflowsArgs } from "./completions.js"
import type { Subcommand, WorkflowsCommandDeps } from "./types.js"

/** 路由表：cancel/stop、register/reg、unregister/unreg 为同义别名，各指向同一实现 */
const subcommands: Record<string, Subcommand> = {
  list: listSubcommand,
  run: runSubcommand,
  resume: resumeSubcommand,
  analyze: analyzeSubcommand,
  anal: analyzeSubcommand,
  plan: planSubcommand,
  status: statusSubcommand,
  cancel: cancelSubcommand,
  stop: cancelSubcommand,
  register: registerSubcommand,
  reg: registerSubcommand,
  unregister: unregisterSubcommand,
  unreg: unregisterSubcommand,
  ui: uiSubcommand,
  watch: watchSubcommand,
}

/** 帮助面板：固定首行 + 路由表 usage 行（同义子命令按实现对象去重） */
function helpText(): string {
  const seen = new Set<Subcommand>()
  const lines = ["workflow 子命令:", "  /workflows                             显示本帮助"]
  for (const sub of Object.values(subcommands)) {
    if (seen.has(sub)) continue
    seen.add(sub)
    lines.push(`  /workflows ${sub.usage}`)
  }
  return lines.join("\n")
}

export function registerWorkflowsCommand(pi: ExtensionAPI, deps: WorkflowsCommandDeps): void {
  pi.registerCommand("workflows", {
    description:
      "workflow 命令入口（无参数显示帮助）；ui 打开 Navigator 全屏面板；watch <runId> 单 run 专注视图；list 列出注册表；register|reg 注册脚本；unregister|unreg 注销；run <路径|名> [k=v...] 后台执行；resume <路径|名> [--tasks|--status] 任务级恢复；analyze|anal <路径|名> 静态分析；plan validate <plan.json> 校验 Plan；status <runId> / cancel|stop [runId]（带 id 停单个，无 id 停全部在途）",
    // Tab 参数补全：子命令名 / 注册表 workflowId / runId（宿主 getArgumentCompletions，无 ctx，cwd 取进程根）
    // 注意：这里只能引用 deps.*，裸 runManager 不在作用域（曾是线上 ReferenceError：按 Tab 即崩宿主）
    getArgumentCompletions: (prefix: string) =>
      completeWorkflowsArgs(prefix, { runManager: deps.runManager, cwd: process.cwd() }),
    handler: async (args: string, ctx: any) => {
      const argv = args.trim().split(/\s+/).filter(Boolean)
      if (!argv.length) {
        ctx.ui.notify(helpText(), "info")
        return
      }
      const sub = subcommands[argv[0]]
      if (!sub) {
        ctx.ui.notify(`未知子命令: ${argv[0]}\n${helpText()}`, "warning")
        return
      }
      await sub.run(argv.slice(1), ctx, deps)
    },
  })
}

export type { WorkflowsCommandDeps } from "./types.js"
