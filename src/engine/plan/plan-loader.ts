/**
 * Plan Loader（M1-T1）
 *
 * 定位约定（架构基线 4.2）：
 *  - `<script>.plan.json`（脚本同级）优先
 *  - `.pi/workflows/plans/<workflowId>.plan.json`
 *  - 都没有 → 返回 null（旧 Workflow 无 Plan，正常工作，Analyzer 只是建议创建）
 *
 * 也接受显式路径。
 */
import fs from "node:fs"
import path from "node:path"

import { hashPlan, hashScript } from "./source-fingerprint.js"
import { validatePlan, type PlanValidationResult } from "./plan-validator.js"
import { DEFAULT_PROFILE, type WorkflowPlan } from "./schema.js"

export interface LoadPlanResult {
  /** null = 没有 Plan 文件（旧 Workflow，兼容路径） */
  plan: WorkflowPlan | null
  /** Plan 文件路径（存在时） */
  path?: string
  /** 校验结果（plan 存在时） */
  validation?: PlanValidationResult
  /** Plan 是否过期（scriptHash 与当前脚本不一致） */
  stale: boolean
  /** 默认生效 Profile */
  defaultProfile: string
  /** 非致命提示（例如找到多个候选、回落默认 Profile） */
  notes: string[]
}

/** 候选 Plan 路径列表（按优先级） */
export function planCandidates(scriptPath: string, cwd = process.cwd()): string[] {
  const abs = path.resolve(cwd, scriptPath)
  const dir = path.dirname(abs)
  const base = path.basename(abs).replace(/\.(m?js)$/, "")
  const relToWorkflows = path.relative(cwd, abs)
  const underWorkflows = relToWorkflows.split(path.sep).includes("workflows")
  return [
    path.join(dir, `${path.basename(abs)}.plan.json`),
    path.join(dir, `${base}.plan.json`),
    ...(underWorkflows ? [path.join(cwd, ".pi", "workflows", "plans", `${base}.plan.json`)] : []),
  ]
}

export function loadPlan(input: { scriptPath: string; cwd?: string; explicitPath?: string }): LoadPlanResult {
  const cwd = input.cwd ?? process.cwd()
  const notes: string[] = []
  const scriptAbs = path.resolve(cwd, input.scriptPath)
  const scriptExists = fs.existsSync(scriptAbs)
  const scriptSource = scriptExists ? fs.readFileSync(scriptAbs, "utf8") : undefined

  const candidates = input.explicitPath
    ? [path.resolve(cwd, input.explicitPath)]
    : planCandidates(input.scriptPath, cwd)
  const found = candidates.find((p) => fs.existsSync(p))

  if (!found) {
    return { plan: null, stale: false, defaultProfile: DEFAULT_PROFILE, notes: ["未找到 Plan 文件（旧 Workflow，兼容运行）"] }
  }

  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(found, "utf8"))
  } catch (e) {
    return {
      plan: null,
      path: found,
      stale: false,
      defaultProfile: DEFAULT_PROFILE,
      notes: [`Plan JSON 解析失败：${String((e as Error)?.message ?? e)}`],
    }
  }

  const validation = validatePlan(raw, { scriptSource })
  const plan = (validation.plan ?? (raw as WorkflowPlan)) as WorkflowPlan
  const stale = Boolean(plan.source?.scriptHash && scriptSource && hashScript(scriptSource) !== plan.source.scriptHash)
  if (stale) notes.push("Plan 已过期（source.scriptHash 与当前脚本不一致），需重新分析")
  if (plan.planHash && hashPlan(plan) !== plan.planHash) {
    notes.push("planHash 与内容不一致（Plan 被手工修改，未重算指纹）")
  }
  if (!plan.profiles?.[validation.defaultProfile]) notes.push(`默认 Profile ${validation.defaultProfile} 未声明`)

  return { plan, path: found, validation, stale, defaultProfile: validation.defaultProfile, notes }
}

/** 解析 Profile 的有效执行策略：Definition 强制项不可被覆盖，Profile 只提供增量 */
export function resolveEffectivePolicy(plan: WorkflowPlan, profileName: string) {
  const profile = plan.profiles?.[profileName] ?? plan.profiles?.[DEFAULT_PROFILE] ?? {}
  return {
    profile: profileName in (plan.profiles ?? {}) ? profileName : DEFAULT_PROFILE,
    mode: profile.mode,
    concurrency: profile.concurrency,
    modelPolicy: profile.modelPolicy,
    budget: profile.budget,
    // 强制验证：Definition 的 requiredValidation 恒生效，Profile 只能追加
    requiredValidation: plan.definition?.quality?.requiredValidation === true,
    acceptanceCriteria: plan.definition?.quality?.acceptanceCriteria ?? [],
    additionalValidation: profile.additionalValidation ?? [],
  }
}
