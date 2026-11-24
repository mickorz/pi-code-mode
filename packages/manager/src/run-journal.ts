/**
 * Run 级 Journal 接线共享层。
 *
 * 存在理由（评审修复 H1/M2）：Journal 的读取方（Explorer 详情）与写入方（workflow 工具 /
 * schedule runner）必须是**同一个 JournalStore 实例**——该实例的 entries 缓存与写入共用同一对象，
 * 否则读取方会永久命中陈旧的内存副本（运行中打开面板后详情再也不更新）。
 *
 * 落盘目录：`.pi/workflows/journal`（opencode 兼容路径由 JournalStore 缺省值提供）。
 */

import path from "node:path"
import { JournalStore } from "../../engine/src/persistence/journal.js"

/** 相对项目根的 journal 目录（与 /workflows 命令、Explorer 共用） */
export const RUN_JOURNAL_DIR = path.join(".pi", "workflows", "journal")

/** 按项目根创建 run journal（同一进程请复用同一实例，见文件头说明） */
export function createRunJournal(cwd: string): JournalStore {
  return new JournalStore(cwd, path.join(cwd, RUN_JOURNAL_DIR))
}

export interface RunSummaryOutcome {
  workflows?: unknown[]
  phases?: unknown[]
  composites?: unknown[]
  agents?: unknown[]
  tools?: unknown[]
  meta?: { name?: string; id?: string }
}

/**
 * run 终态写 V2 journal 观测快照：一次性写入，不写高频事件。
 * 只改 metadata/observability 两个字段，entries（Agent 结果回放）原样保留 —— 回放语义不变。
 * 失败不阻断运行（journal 仅影响历史回看与 Node Detail 展示）。
 */
export function persistRunSummary(
  journal: JournalStore,
  runId: string,
  outcome: RunSummaryOutcome | undefined,
  status: string,
  error?: string,
  extras?: { lastSequence?: number; startedAt?: number },
): void {
  try {
    journal.recordRunSummary(runId, {
      metadata: {
        workflowId: outcome?.meta?.id,
        workflowName: outcome?.meta?.name,
        status,
        startedAt: extras?.startedAt,
        endedAt: Date.now(),
        ...(error ? { error } : {}),
      } as never,
      observability: {
        lastSequence: extras?.lastSequence,
        workflows: outcome?.workflows,
        phases: outcome?.phases,
        composites: outcome?.composites,
        agents: outcome?.agents,
        tools: outcome?.tools,
      },
    })
  } catch {
    // 展示层可失败：不因 journal 写入失败影响 run 结果返回
  }
}
