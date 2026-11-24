/**
 * schedule_* 工具族（M4）：定时任务的创建/查询/启停/删除/立即执行
 *
 * 移植自 opencode 版 tools/schedule.ts（tool DSL -> pi typebox）。
 * cron 子集四模式：每 n 分钟 / 每小时 m 分 / 每天 h 点 m 分 / 每周 W 的 h 点 m 分（W 0-6，0=周日）。
 * 语义：到点由插件内调度器确定性执行（不经 LLM 判断）；pi 运行期间生效，关闭不执行、错过不补跑；
 * checkpoint 即败（无人值守无确认通道）。
 */

import { Type } from "typebox"
import {
  createSchedule,
  listScheduleViews,
  getScheduleView,
  updateSchedule,
  setScheduleEnabled,
  removeSchedule,
  type UpdateSchedulePatch,
} from "../../engine/src/schedule/service.js"
import type { ScheduleView } from "../../engine/src/schedule/types.js"
import type { ScheduleRuntime } from "../../engine/src/schedule/runtime.js"

export interface ScheduleToolsDeps {
  scheduler: ScheduleRuntime
  cwd?: string
}

function renderView(v: ScheduleView): string {
  const lines = [
    `- ${v.id}  ${v.name ?? v.workflowId}  cron=${v.cron}  ${v.enabled ? "启用" : "停用"}`,
    `  workflow: ${v.workflowId}${v.workflowMissing ? "（已缺失！）" : ""}  args: ${JSON.stringify(v.args ?? {})}`,
  ]
  if (v.lastRunStatus) lines.push(`  上次: ${v.lastRunStatus} ${v.lastRunAt ?? ""}`)
  if (v.nextRunAt) lines.push(`  下次: ${v.nextRunAt}`)
  return lines.join("\n")
}

export function makeScheduleTools(deps: ScheduleToolsDeps) {
  const cwd = () => deps.cwd ?? process.cwd()

  const scheduleCreate = {
    name: "schedule_create",
    label: "Schedule Create",
    description:
      "创建 Workflow 定时任务。自然语言定时意图（每分钟/每小时/每天/每周）由调用方翻译成 cron 后传入；到点由插件内调度器确定性执行 workflowId（不经 LLM）。pi 运行期间生效，关闭不执行、错过不补跑。",
    promptSnippet: "schedule_create: create a cron-scheduled workflow run",
    parameters: Type.Object({
      workflowId: Type.String({ description: "workflowId（.pi/workflows/ 或兼容目录下脚本的 meta.id ?? meta.name）" }),
      cron: Type.String({
        description: "cron 子集四模式：每 n 分钟（星/n 空格 星 星 星 星）、每小时 m 分、每天 h 点 m 分、每周 W 的 h 点 m 分（W 0-6，0=周日）",
      }),
      name: Type.Optional(Type.String({ description: "展示名；缺省用 workflowId" })),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "透传给 workflow 脚本的全局 args" })),
      timeoutMs: Type.Optional(Type.Number({ description: "单轮超时毫秒数，到点中止并记 timeout；缺省不限" })),
    }),
    async execute(_toolCallId: string, params: any) {
      try {
        const s = createSchedule({
          directory: cwd(),
          workflowId: params.workflowId,
          cron: params.cron,
          name: params.name,
          args: params.args,
          timeoutMs: params.timeoutMs,
        })
        return toolText(`定时任务已创建:\n${renderView({ ...s, workflowMissing: false, lastRun: undefined, nextRun: undefined } as any)}`)
      } catch (e) {
        return toolText(`[schedule_create 失败] ${String((e as Error)?.message ?? e)}`)
      }
    },
  }

  const scheduleList = {
    name: "schedule_list",
    label: "Schedule List",
    description: "列出全部定时任务（含上次执行结果与下次执行时间）。",
    promptSnippet: "schedule_list: list scheduled workflow runs",
    parameters: Type.Object({}),
    async execute() {
      const views = listScheduleViews(cwd())
      if (!views.length) return toolText("当前没有任何定时任务")
      return toolText(`共 ${views.length} 个定时任务:\n${views.map(renderView).join("\n")}`)
    },
  }

  const scheduleGet = {
    name: "schedule_get",
    label: "Schedule Get",
    description: "查询单个定时任务详情（含最近执行记录）。",
    promptSnippet: "schedule_get: get one scheduled workflow",
    parameters: Type.Object({
      id: Type.String({ description: "定时任务 id" }),
    }),
    async execute(_id: string, params: any) {
      const view = getScheduleView(cwd(), params.id)
      if (!view) return toolText(`未找到定时任务: ${params.id}`)
      return toolText(renderView(view))
    },
  }

  const scheduleUpdate = {
    name: "schedule_update",
    label: "Schedule Update",
    description: "更新定时任务（cron/name/args/timeoutMs，传 null 清除可选字段）。",
    promptSnippet: "schedule_update: update a scheduled workflow",
    parameters: Type.Object({
      id: Type.String({ description: "定时任务 id" }),
      cron: Type.Optional(Type.String({ description: "新的 cron 表达式" })),
      name: Type.Optional(Type.String({ description: "新的展示名" })),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "新的 args（整体替换）" })),
      timeoutMs: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "新的单轮超时；null 取消超时" })),
    }),
    async execute(_id: string, params: any) {
      try {
        const patch: UpdateSchedulePatch = {}
        if (params.cron !== undefined) patch.cron = params.cron
        if (params.name !== undefined) patch.name = params.name
        if (params.args !== undefined) patch.args = params.args
        if (params.timeoutMs !== undefined) patch.timeoutMs = params.timeoutMs
        const s = updateSchedule(cwd(), params.id, patch)
        return toolText(`已更新: ${s.id}  cron=${s.cron}  ${s.enabled ? "启用" : "停用"}`)
      } catch (e) {
        return toolText(`[schedule_update 失败] ${String((e as Error)?.message ?? e)}`)
      }
    },
  }

  const scheduleEnable = {
    name: "schedule_enable",
    label: "Schedule Enable",
    description: "启用定时任务。",
    promptSnippet: "schedule_enable: enable a scheduled workflow",
    parameters: Type.Object({ id: Type.String({ description: "定时任务 id" }) }),
    async execute(_id: string, params: any) {
      const s = setScheduleEnabled(cwd(), params.id, true)
      return toolText(`已启用: ${s.id}  cron=${s.cron}`)
    },
  }

  const scheduleDisable = {
    name: "schedule_disable",
    label: "Schedule Disable",
    description: "停用定时任务（保留配置，不再到点触发）。",
    promptSnippet: "schedule_disable: disable a scheduled workflow",
    parameters: Type.Object({ id: Type.String({ description: "定时任务 id" }) }),
    async execute(_id: string, params: any) {
      const s = setScheduleEnabled(cwd(), params.id, false)
      return toolText(`已停用: ${s.id}  cron=${s.cron}`)
    },
  }

  const scheduleDelete = {
    name: "schedule_delete",
    label: "Schedule Delete",
    description: "删除定时任务（配置文件移除，历史 Record 保留）。",
    promptSnippet: "schedule_delete: delete a scheduled workflow",
    parameters: Type.Object({ id: Type.String({ description: "定时任务 id" }) }),
    async execute(_id: string, params: any) {
      removeSchedule(cwd(), params.id)
      return toolText(`已删除（若存在）: ${params.id}`)
    },
  }

  const scheduleRunNow = {
    name: "schedule_run_now",
    label: "Schedule Run Now",
    description: "立即执行一次定时任务（跳过时间判定，走同一执行路径；手动语义）。",
    promptSnippet: "schedule_run_now: run a scheduled workflow immediately",
    parameters: Type.Object({ id: Type.String({ description: "定时任务 id" }) }),
    async execute(_id: string, params: any) {
      const res = await deps.scheduler.runNow(params.id)
      if (res.error) return toolText(`[schedule_run_now 失败] ${res.error}`)
      return toolText(`已触发立即执行: ${params.id} -> runId=${res.runId}（后台运行，完成后结果回传本会话）`)
    },
  }

  return [
    scheduleCreate,
    scheduleList,
    scheduleGet,
    scheduleUpdate,
    scheduleEnable,
    scheduleDisable,
    scheduleDelete,
    scheduleRunNow,
  ]
}

function toolText(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} }
}
