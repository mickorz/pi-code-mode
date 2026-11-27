/**
 * 受控面审计落盘（M2-W4 收尾）
 *
 * 设计取舍：
 *   - **append-only JSONL**：一行一事件，只追加不重写（并发安全、崩溃不丢已写记录、
 *     可 grep/jq 直接消费）。不塞进 run journal，因为 journal 是"按 run 一次性写终态快照"，
 *     而审计需要逐事件追加且有宿主执行这种跨 run 的决策。
 *   - **只记事实**：命令文本、cwd、规则理由、决策、退出码、耗时、runId/executionId。
 *     **绝不写 stdout/stderr 内容**（ControlPlaneExecutor 的审计事件本身就不含输出）。
 *   - **失败不阻断执行**：磁盘写失败只记一次警告，不影响命令结果（审计是旁路，
 *     不是执行前提；若反过来会让磁盘问题变成执行故障）。
 *   - **按日分文件**：`control-plane-YYYY-MM-DD.jsonl`，便于轮转与按天排查。
 */

import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import type { ControlPlaneAuditEvent } from "../command/control-plane.js"

export const AUDIT_DIR = path.join(".pi", "workflows", "audit")

export interface ControlPlaneAuditRecord extends ControlPlaneAuditEvent {
  /** ISO 时间戳（人类可读；at 保留为毫秒数供程序消费） */
  ts: string
  /** 事件类型标记，便于与其它审计混存时过滤 */
  kind: "control-plane"
}

/** 按日文件名（本地时区，便于"今天发生了什么"排查） */
export function auditFileName(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `control-plane-${y}-${m}-${d}.jsonl`
}

/** 审计写入器：串行化追加（避免并发写交错），写失败只警告一次 */
export class ControlPlaneAuditWriter {
  private queue: Promise<void> = Promise.resolve()
  private warned = false
  private readonly dir: string

  constructor(
    private readonly cwd: string,
    private readonly onWarn?: (message: string) => void,
  ) {
    this.dir = path.join(cwd, AUDIT_DIR)
  }

  /** 落一条审计事件（返回 Promise 便于测试等待；生产调用方可不 await） */
  write(event: ControlPlaneAuditEvent): Promise<void> {
    const record: ControlPlaneAuditRecord = {
      ...event,
      ts: new Date(event.at).toISOString(),
      kind: "control-plane",
    }
    const line = `${JSON.stringify(record)}\n`
    this.queue = this.queue
      .then(async () => {
        await mkdir(this.dir, { recursive: true })
        await appendFile(path.join(this.dir, auditFileName(new Date(event.at))), line, "utf8")
      })
      .catch((e) => {
        // 审计失败不阻断执行；只警告一次，避免刷屏
        if (!this.warned) {
          this.warned = true
          this.onWarn?.(`控制面审计落盘失败（后续同类失败将静默）: ${String((e as Error)?.message ?? e)}`)
        }
      })
    return this.queue
  }

  /** 等待已排队的写入完成（测试/退出前 flush 用） */
  async flush(): Promise<void> {
    await this.queue
  }
}
