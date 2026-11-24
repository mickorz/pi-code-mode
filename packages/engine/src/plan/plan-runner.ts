/**
 * Plan Runner（M2-T4）：把 WorkflowPlan + Run 选择组合成 WorkflowRunConfig 与注入参数
 *
 * 职责：
 *  - 读 Plan（M1 Loader）+ 选定 Profile（缺省 defaultProfile / balanced）
 *  - 产出：BudgetGate（含 activeProfile/effectivePolicy/policyTransitions）、concurrency、modelPolicy
 *  - 旧 Workflow（无 Plan）→ 返回 null，调用方走原路径（零改动兼容）
 */
import fs from "node:fs"
import path from "node:path"

import { BudgetGate } from "../governance/budget-gate.js"
import { loadPlan } from "./plan-loader.js"
import { hashPlan, hashProfile } from "./source-fingerprint.js"
import { DEGRADE_ORDER } from "../governance/policy-state.js"
import type { PlanExecutionPolicy, WorkflowPlan, WorkflowRunConfig } from "./schema.js"

export interface PlanRunContext {
  plan: WorkflowPlan
  planPath: string
  /** 初始选择的 Profile（= WorkflowRunConfig.activeProfile） */
  activeProfile: string
  planHash: string
  profileHash: string
  /** 该 Profile 解析后的有效策略（含 Definition 强制项合并后的视图） */
  policy: PlanExecutionPolicy
  /** 参与降级的 Profile 策略表 */
  profiles: Record<string, PlanExecutionPolicy>
  requiredValidation: boolean
  /** 预算闸（limits 来自 Profile.budget） */
  budgetGate: BudgetGate
  /** 覆盖脚本 setConcurrency 的 Run 级并发（Profile.concurrency.max） */
  concurrency?: number
  /** modelPolicy（analysis/writing → tier 名） */
  modelPolicy?: { analysis?: string; writing?: string }
  notes: string[]
}

export interface ResolvePlanOptions {
  /** 脚本路径（相对 cwd） */
  scriptPath?: string
  /** 显式 Plan 路径 */
  planPath?: string
  cwd?: string
  /** 指定 Profile（缺省 Plan 默认 Profile） */
  profile?: string
  /** Run id（用于 BudgetGate） */
  runId: string
  /** 强制验证是否启用（覆盖 Definition；缺省取 Definition.quality.requiredValidation） */
  requiredValidation?: boolean
}

/** 读取并解析 Plan → PlanRunContext；无 Plan 返回 null（旧 Workflow 兼容） */
export function resolvePlanContext(opts: ResolvePlanOptions): PlanRunContext | null {
  const cwd = opts.cwd ?? process.cwd()
  // M6-P1-3：只用 planPath（无 scriptPath）时，绝不能把 Plan JSON 当成脚本哈希 —— 那会恒报 stale
  const effectiveScriptPath = opts.scriptPath
  const loaded = loadPlan({
    ...(effectiveScriptPath ? { scriptPath: effectiveScriptPath } : { scriptPath: opts.planPath ?? "" }),
    cwd,
    ...(opts.planPath ? { explicitPath: opts.planPath } : {}),
  })
  if (!loaded.plan) return null

  const plan = loaded.plan
  const notes = [...loaded.notes]
  // 仅当确实拿到了脚本内容（有 scriptPath 或可推导）时才报告过期
  const hasScript = Boolean(effectiveScriptPath)
  if (loaded.stale && hasScript) notes.push("Plan 已过期：source.scriptHash 与当前脚本不一致（建议重新 analyze）")
  else if (loaded.stale && !hasScript) notes.push("未能定位关联脚本，跳过 Plan 过期判定")

  const requested = opts.profile ?? loaded.defaultProfile
  const activeProfile = plan.profiles?.[requested] ? requested : loaded.defaultProfile
  if (activeProfile !== requested) notes.push(`Profile ${requested} 未声明，回落 ${activeProfile}`)

  const profilePolicy = (plan.profiles?.[activeProfile] ?? {}) as PlanExecutionPolicy
  const requiredValidation = opts.requiredValidation ?? plan.definition?.quality?.requiredValidation === true

  // 降级候选表：Definition 强制项不进 Profile（Profile 只能追加验证）
  const profiles: Record<string, PlanExecutionPolicy> = {}
  for (const name of Object.keys(plan.profiles ?? {})) {
    profiles[name] = plan.profiles[name] as PlanExecutionPolicy
  }
  // 保证降级链完整（缺声明时用空策略占位，仅用于降级目标存在性）
  for (const name of DEGRADE_ORDER) if (!profiles[name]) profiles[name] = {}

  const budgetGate = new BudgetGate({
    runId: opts.runId,
    limits: profilePolicy.budget ?? {},
    activeProfile,
    initialPolicy: profilePolicy,
    requiredValidation,
    profiles,
  })

  return {
    plan,
    planPath: loaded.path!,
    activeProfile,
    planHash: plan.planHash ?? hashPlan(plan),
    profileHash: hashProfile(plan, activeProfile),
    policy: profilePolicy,
    profiles,
    requiredValidation,
    budgetGate,
    ...(profilePolicy.concurrency?.max !== undefined ? { concurrency: profilePolicy.concurrency.max } : {}),
    ...(profilePolicy.modelPolicy ? { modelPolicy: profilePolicy.modelPolicy } : {}),
    notes,
  }
}

/** 生成 RunConfig（写入结果/日志/后续 M5 Evaluator） */
export function toRunConfig(ctx: PlanRunContext, extra: { workflowId?: string } = {}): WorkflowRunConfig {
  return ctx.budgetGate.policyState.toRunConfig({
    ...(extra.workflowId ? { workflowId: extra.workflowId } : planWorkflowId(ctx) ? { workflowId: planWorkflowId(ctx)! } : {}),
    planHash: ctx.planHash,
    profileHash: ctx.profileHash,
  })
}

function planWorkflowId(ctx: PlanRunContext): string | undefined {
  return ctx.plan.workflowId
}

/** parse `--plan`/`--profile` 形式的 CLI 参数（供工具与 CLI 共用） */
export function parsePlanArgs(argv: string[]): { scriptPath?: string; planPath?: string; profile?: string } {
  const out: { scriptPath?: string; planPath?: string; profile?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--plan") out.planPath = argv[++i]
    else if (a === "--profile") out.profile = argv[++i]
    else if (!a.startsWith("--") && !out.scriptPath) out.scriptPath = a
  }
  return out
}

/** 便捷：从 Plan 路径推导脚本路径（Plan 同级同名 .js/.mjs） */
export function scriptFromPlanPath(planPath: string, cwd = process.cwd()): string | undefined {
  const abs = path.resolve(cwd, planPath)
  const fileName = path.basename(abs)
  // demo.js.plan.json → demo.js；demo.plan.json → demo
  const base = fileName.replace(/\.plan\.json$/, "").replace(/\.json$/, "")
  const hasExt = /\.(m?js)$/.test(base)
  for (const ext of [".js", ".mjs"]) {
    const candidate = path.join(path.dirname(abs), hasExt ? base : `${base}${ext}`)
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return undefined
}
