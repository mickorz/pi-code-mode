/**
 * Schedule 的宿主管理接口（pi 版）——替代 opencode 版对 BackgroundRunManager/ClientLike 的具体类依赖
 *
 * 结构化接口（鸭子类型）：ScheduleRuntime 只依赖本文件形状，pi 侧由 PiScheduleRunner 实现。
 * ClientLike 保留参数位（opencode 语义兼容），pi 版实现不消费它。
 */

import type { AgentRecord } from "../types/index.js"

/** 宿主 client 占位：pi 版实现不直调 client（root session 由 pi 适配层创建） */
export type ScheduleClientLike = unknown

/** 后台 run 终态信息（onFinished 载荷；字段与 opencode 版 BackgroundRunInfo 兼容子集） */
export interface ScheduleRunInfo {
  runId: string
  name: string
  status: "running" | "completed" | "failed" | "stopped" | "timeout"
  startedAt: number
  endedAt?: number
  records: AgentRecord[]
  logs: string[]
  error?: string
}

export interface ScheduleStartDeps {
  client: ScheduleClientLike
  parentSessionId: string
  directory: string
  rootSessionId: string
}

export interface ScheduleStartInput {
  script: string
  args?: unknown
  /** checkpoint 即败（无人值守） */
  confirm?: () => Promise<unknown>
  trigger?: { type: string; scheduleId?: string; scheduledAt?: string }
  onFinished?: (info: ScheduleRunInfo) => void
}

/** ScheduleRuntime 依赖的管理接口（pi 版由 PiScheduleRunner 实现） */
export interface ScheduleManagerLike {
  createRootSession(client: ScheduleClientLike, title: string): Promise<string>
  start(deps: ScheduleStartDeps, input: ScheduleStartInput): string
  stop(runId: string): Promise<boolean>
}
