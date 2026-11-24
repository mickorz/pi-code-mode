/**
 * /schedule 斜杠命令（独立文件，主入口只做装配）
 *
 * 职责：查看定时任务列表与 schedule_create 用法（创建/修改走 schedule_* 工具自然对话）。
 * 复用 makeScheduleTools 中的 schedule_list 工具渲染列表，与工具层输出保持一致。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { makeScheduleTools } from "../../../../packages/tools/src/schedule-tools.js"
import type { ScheduleRuntime } from "../../../../packages/engine/src/schedule/runtime.js"

export interface ScheduleCommandDeps {
  /** 已启动的调度运行时（主入口创建并 start） */
  scheduler: ScheduleRuntime
}

export function registerScheduleCommand(pi: ExtensionAPI, deps: ScheduleCommandDeps): void {
  const { scheduler } = deps

  pi.registerCommand("schedule", {
    description: "查看定时任务列表与 schedule_create 用法",
    handler: async (_name: string, ctx: any) => {
      const cwd = ctx.cwd ?? process.cwd()
      const lines: string[] = []
      try {
        for (const tool of makeScheduleTools({ scheduler, cwd })) {
          if (tool.name === "schedule_list") {
            const r = await (tool as any).execute("cmd", {}, undefined, undefined, { cwd })
            lines.push(r.content[0].text)
          }
        }
      } catch (e) {
        lines.push(`读取失败: ${String((e as Error)?.message ?? e)}`)
      }
      lines.push("")
      lines.push("创建定时任务：对话中描述需求（如「每天 9 点跑 daily-review」），由 schedule_create 落配置；")
      lines.push("边界：pi 运行期间生效，关闭不执行、错过不补跑；checkpoint 在无人值守执行中视为失败。")
      ctx.ui.notify(lines.join("\n"), "info")
    },
  })
}
