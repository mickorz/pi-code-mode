/**
 * 上下文三层管理（M4-T2）
 *
 * 核心约束（五轮评审 P0-3）：**减少重复传输 ≠ 减少必要信息**
 *
 *  - Shared Context：所有任务都需要的基础信息 → 公共引用（不重复注入全文）
 *  - Task Context：每个任务独有的输入 → 独立传递
 *  - Evidence Reference：必须保留的原始证据 → 按需读取；**不因生成摘要而丢弃原始来源**
 *
 * 反例：48 个任务共享一份规则文档时，**不得**把规则压缩成摘要再分发。
 * 摘要只能进 Shared Context 层作为导航，Evidence Reference 层必须保留原文引用。
 */
import { contentHash } from "../governance/task-fingerprint.js"

export interface EvidenceRef {
  /** 证据引用（文件路径 / URL / ctx:// 形式） */
  ref: string
  /** 覆盖范围说明（可定位到片段） */
  span?: string
  /** 条目数（完整性校验用） */
  itemCount?: number
}

export interface SharedContext {
  /** 公共引用 id（任务 prompt 里只放引用，不放全文） */
  ref: string
  /** 导航用摘要（**不是**原文替代品） */
  summary?: string
  /** 原文大小（供调用方判断是否需要引用而非内联） */
  sourceBytes?: number
  /** 原始证据引用（必须保留） */
  evidence: EvidenceRef[]
}

export interface TaskContext {
  taskKey: string
  /** 该任务独有输入（分片内容） */
  input: unknown
  /** 该任务需要读取的证据子集（按需） */
  evidenceRefs?: EvidenceRef[]
}

export interface LayerValidation {
  ok: boolean
  /** 证据覆盖率：任务可用证据 / 应有证据（1.0 = 未丢失） */
  evidenceCoverage: number
  errors: string[]
}

/** 三层上下文容器 */
export class LayeredContext {
  private readonly shared: Map<string, SharedContext> = new Map()
  private readonly tasks: Map<string, TaskContext> = new Map()

  /** 注册公共上下文：只存引用 + 可选导航摘要 + 完整证据引用 */
  registerShared(input: { ref: string; summary?: string; sourceBytes?: number; evidence: EvidenceRef[] }): SharedContext {
    if (input.evidence.length === 0) {
      throw new Error(`共享上下文 ${input.ref} 必须至少保留一条 Evidence Reference（不允许只有摘要）`)
    }
    const ctx: SharedContext = {
      ref: input.ref,
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.sourceBytes !== undefined ? { sourceBytes: input.sourceBytes } : {}),
      evidence: [...input.evidence],
    }
    this.shared.set(input.ref, ctx)
    return ctx
  }

  getShared(ref: string): SharedContext | undefined {
    return this.shared.get(ref)
  }

  registerTask(ctx: TaskContext): void {
    this.tasks.set(ctx.taskKey, ctx)
  }

  getTask(taskKey: string): TaskContext | undefined {
    return this.tasks.get(taskKey)
  }

  /**
   * 生成任务 prompt 的上下文段：
   *  - 公共部分只放引用（+ 可选摘要作为导航）
   *  - 独有输入内联
   *  - 明确列出可按需读取的证据引用
   */
  renderForTask(taskKey: string, sharedRef: string): string {
    const task = this.tasks.get(taskKey)
    const shared = this.shared.get(sharedRef)
    const lines: string[] = []
    if (shared) {
      lines.push(`[Shared Context] ${shared.ref}${shared.summary ? ` —— ${shared.summary}` : ""}`)
      if (shared.sourceBytes !== undefined) lines.push(`（原文 ${shared.sourceBytes} 字节，通过引用读取，不要在任务内重复粘贴）`)
      lines.push(`[Evidence Reference] 原始证据可按需读取：`)
      for (const e of shared.evidence) {
        lines.push(`  - ${e.ref}${e.span ? ` (${e.span})` : ""}${e.itemCount !== undefined ? ` [${e.itemCount} 条]` : ""}`)
      }
    }
    if (task) {
      lines.push("")
      lines.push(`[Task Context] ${task.taskKey}`)
      lines.push(typeof task.input === "string" ? task.input : JSON.stringify(task.input, null, 2))
      if (task.evidenceRefs?.length) {
        lines.push(`[Task Evidence] 本任务相关证据：`)
        for (const e of task.evidenceRefs) lines.push(`  - ${e.ref}${e.span ? ` (${e.span})` : ""}`)
      }
    }
    return lines.join("\n")
  }

  /** 校验证据覆盖率：每个任务可访问的证据 / 应有权访问的证据 */
  validate(expectedEvidence: EvidenceRef[]): LayerValidation {
    const errors: string[] = []
    // 所有共享上下文必须保留完整证据
    for (const [, ctx] of this.shared) {
      if (ctx.evidence.length === 0) errors.push(`共享上下文 ${ctx.ref} 丢失全部证据引用`)
    }
    const available = new Set<string>()
    for (const [, ctx] of this.shared) for (const e of ctx.evidence) available.add(e.ref)
    for (const [, t] of this.tasks) for (const e of t.evidenceRefs ?? []) available.add(e.ref)

    const missing = expectedEvidence.filter((e) => !available.has(e.ref))
    if (missing.length > 0) errors.push(`证据引用缺失：${missing.map((m) => m.ref).join(", ")}`)

    const coverage = expectedEvidence.length === 0 ? 1 : (expectedEvidence.length - missing.length) / expectedEvidence.length
    return { ok: errors.length === 0 && coverage === 1, evidenceCoverage: coverage, errors }
  }

  /** 估算「若不使用共享引用」时的重复传输量（用于对照 Benchmark） */
  estimateSavings(inlineBytes: number): { inlineBytes: number; sharedPlaceholderBytes: number; savedBytes: number; savedRatio: number } {
    const placeholder = [...this.shared.values()].reduce((a, c) => a + c.ref.length + (c.summary?.length ?? 0), 0)
    const taskCount = this.tasks.size || 1
    const inlineTotal = inlineBytes * taskCount
    return {
      inlineBytes: inlineTotal,
      sharedPlaceholderBytes: placeholder * taskCount,
      savedBytes: Math.max(0, inlineTotal - placeholder * taskCount),
      savedRatio: inlineTotal === 0 ? 0 : Math.max(0, 1 - (placeholder * taskCount) / inlineTotal),
    }
  }

  /** 上下文指纹（供任务指纹的 inputHash 使用：公共引用变化应失效，摘要措辞变化也失效） */
  fingerprint(sharedRef: string): string {
    const shared = this.shared.get(sharedRef)
    if (!shared) return contentHash({ ref: sharedRef, missing: true })
    return contentHash({ ref: shared.ref, summary: shared.summary ?? "", evidence: shared.evidence })
  }
}
