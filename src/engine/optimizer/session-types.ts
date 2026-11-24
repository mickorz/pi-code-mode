/**
 * Workflow Optimize 会话契约（O0）
 *
 * 会话是优化的唯一事实源：所有阶段（分析 / 补丁 / 校验 / 基准 / 应用）都读写这里的字段。
 * 落盘位置 `.pi/workflows/optimizations/<id>/session.json`，可审计、可恢复。
 *
 * 安全不变量（详见执行计划 §2）：
 *  - optimize / review / benchmark 阶段生产文件零写入
 *  - 只有 apply 允许写生产文件，且必须先验 source hash + 建 backup
 */

export type OptimizationStatus =
  | "analyzed"
  | "proposed"
  | "patched"
  | "static-verified"
  | "benchmark-pending"
  | "benchmarked"
  | "ready"
  | "applied"
  | "rolled-back"
  | "stale"
  | "rejected"
  | "failed"
  | "discarded"

export type CheckResult = "pass" | "fail" | "partial" | "pending" | "unavailable"

export interface OptimizationSession {
  schemaVersion: "1.0"
  id: string
  createdAt: string
  updatedAt: string
  status: OptimizationStatus

  target: {
    kind: "file" | "directory" | "registry"
    /** 用户输入的原始引用（file-or-dir 或 registry 名） */
    ref: string
    /** 解析后的根目录（绝对路径）；apply 时的写入边界 */
    root: string
    /** 所有待修改生产文件的 hash（相对 root 的路径 → sha256） */
    sourceHashes: Record<string, string>
    /** 参与分析的 js 文件（相对 root） */
    files: string[]
  }

  /** 选中的问题簇 key（对应 AnalysisReport.clusters[].key） */
  selectedClusters: string[]

  model: {
    /** 分析档位（AI Rule Check）；2026-11-20 用户决策：分析用 big */
    analyzerTier?: string
    /** 生成/审查档位；2026-11-20 用户决策：执行用 fast */
    generatorTier: string
    generatorModel?: string
    reviewerTier: string
    reviewerModel?: string
  }

  workspace: {
    path: string
    patchApplied: boolean
    /**
     * patch 应用到工作区后的文件 hash（P1-5）。
     * apply 前重算比对：不一致 = review/benchmark 之后工作区被改动，
     * 写回内容已不是被审阅/验证过的那份 → 拒绝写回。
     */
    hashes?: Record<string, string>
  }

  validation: {
    patchSchema?: CheckResult
    sourceUnchanged?: CheckResult
    static?: CheckResult
    aiRuleCheck?: CheckResult
    benchmark?: CheckResult
    quality?: CheckResult
  }

  /** 一句话结论（命令摘要直接展示） */
  reason?: string
  /** 已应用的 patch 文件数（applied 后有意义） */
  appliedFiles?: number
}

/** PatchSet：结构化最小补丁（禁止整文件覆盖） */
export interface PatchEdit {
  startLine: number
  endLine: number
  /**
   * 待替换的原文。**可省略**：省略时用 startLine-endLine 切片作为原文。
   *
   * 为什么允许省略：实测 big 档逐字回传整段原代码时输出量过大，
   * 单次生成超过 240s 超时。行号定位把输出量减半，且切片天然唯一，
   * 比"模型抄一遍原文"更不容易出错。
   *
   * 若提供，validator 会校验它必须等于行号切片（防止行号与内容不一致）。
   */
  oldText?: string
  newText: string
  /** 为什么这样改（review 展示） */
  rationale: string
  /** 关联的问题簇 key */
  relatedCluster: string
}

export interface PatchFile {
  /** 相对 target.root 的路径（正斜杠） */
  path: string
  expectedSourceHash: string
  edits: PatchEdit[]
}

export interface PatchSet {
  schemaVersion: "1.0"
  targetRoot: string
  files: PatchFile[]
  /** 模型无法安全决定时给出待人工决策项，而不是猜 */
  needsHumanDecision?: Array<{
    cluster: string
    question: string
    options: string[]
  }>
}

/** Patch Reviewer 输出 */
export interface PatchReview {
  decision: "approve" | "reject" | "needs-human"
  findings: Array<{
    severity: "high" | "medium" | "low"
    file: string
    evidence: string
    reason: string
  }>
}

export const OPTIMIZER_VERSION = "1.0.0"
