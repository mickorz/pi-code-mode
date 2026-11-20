/**
 * Plan Validator（M1-T1）
 *
 * 校验规则（源自架构基线 2.2 + 五轮评审）：
 *  1. 必填：planVersion / source / definition.stages / definition.quality / profiles
 *  2. 默认 Profile = balanced；每个 Profile 必须是合法对象
 *  3. requiredValidation 为 Definition 级强制项：Profile 不得声明 requiredValidation: false
 *  4. Profile 不得覆盖 stage 结构 / dependsOn（Definition 专属）
 *  5. stage 的 dependsOn 必须指向已声明的 stage id（无环）
 *  6. 错误全部带回可定位路径（`profiles.fast.execution.mode` 形式）
 */
import { DEFAULT_PROFILE, SUPPORTED_PROFILES, type WorkflowPlan } from "./schema.js"
import { hashScript } from "./source-fingerprint.js"

export interface PlanValidationError {
  path: string
  message: string
}

export interface PlanValidationResult {
  ok: boolean
  errors: PlanValidationError[]
  /** 解析后的默认 Profile 名（缺省 balanced） */
  defaultProfile: string
  /** 归一化后的 Plan（补默认值；不修改 planHash 语义） */
  plan?: WorkflowPlan
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v)
}

export function validatePlan(raw: unknown, opts: { scriptSource?: string } = {}): PlanValidationResult {
  const errors: PlanValidationError[] = []
  const push = (path: string, message: string) => errors.push({ path, message })

  if (!isObject(raw)) {
    return { ok: false, errors: [{ path: "", message: "Plan 必须是对象" }], defaultProfile: DEFAULT_PROFILE }
  }
  const plan = raw as unknown as WorkflowPlan

  if (typeof plan.planVersion !== "string" || !plan.planVersion.trim()) push("planVersion", "必须是非空字符串")
  if (!isObject(plan.source)) push("source", "必须是对象")
  if (!isObject(plan.definition)) {
    push("definition", "必须是对象")
    return { ok: false, errors, defaultProfile: DEFAULT_PROFILE }
  }
  if (!Array.isArray(plan.definition.stages)) push("definition.stages", "必须是数组")
  if (!isObject(plan.definition.quality)) push("definition.quality", "必须是对象")
  else if (typeof (plan.definition.quality as any).requiredValidation !== "boolean") {
    push("definition.quality.requiredValidation", "必须是布尔值")
  }
  if (!isObject(plan.profiles)) {
    push("profiles", "必须是对象")
    return { ok: false, errors, defaultProfile: DEFAULT_PROFILE }
  }

  // stage 引用一致性
  if (Array.isArray(plan.definition.stages)) {
    const ids = new Set<string>()
    plan.definition.stages.forEach((s, i) => {
      if (!isObject(s)) return push(`definition.stages[${i}]`, "必须是对象")
      if (typeof s.id !== "string" || !s.id) return push(`definition.stages[${i}].id`, "必须是非空字符串")
      if (ids.has(s.id)) push(`definition.stages[${i}].id`, `重复的 stage id: ${s.id}`)
      ids.add(s.id)
      if (!["parallel", "sequential", "dynamic"].includes(String(s.type))) {
        push(`definition.stages[${i}].type`, `必须是 parallel/sequential/dynamic 之一（实际 ${String(s.type)}）`)
      }
    })
    plan.definition.stages.forEach((s, i) => {
      for (const dep of s.dependsOn ?? []) {
        if (!ids.has(dep)) push(`definition.stages[${i}].dependsOn`, `引用了不存在的 stage: ${dep}`)
      }
    })
  }

  // Profile 校验
  const profileNames = Object.keys(plan.profiles)
  if (profileNames.length === 0) push("profiles", "至少需要一个 profile")
  for (const name of profileNames) {
    const prof = plan.profiles[name] as unknown
    if (!isObject(prof)) {
      push(`profiles.${name}`, "必须是对象")
      continue
    }
    // 强制项不可被 Profile 关闭
    if ("requiredValidation" in prof) {
      push(`profiles.${name}.requiredValidation`, "requiredValidation 是 Definition 级强制项，Profile 不得声明")
    }
    // Definition 专属结构不得出现在 Profile
    for (const forbidden of ["stages", "acceptanceCriteria"]) {
      if (forbidden in prof) push(`profiles.${name}.${forbidden}`, `${forbidden} 属于 Definition，Profile 不得覆盖`)
    }
    const p = prof as Record<string, any>
    if (p.budget && typeof p.budget.maxAgents === "number" && (p.budget.maxAgents as number) < 1) {
      push(`profiles.${name}.budget.maxAgents`, "必须 ≥ 1")
    }
    if (p.concurrency?.max !== undefined && (typeof p.concurrency.max !== "number" || p.concurrency.max < 1)) {
      push(`profiles.${name}.concurrency.max`, "必须是 ≥ 1 的数字")
    }
    if (p.additionalValidation !== undefined && !Array.isArray(p.additionalValidation)) {
      push(`profiles.${name}.additionalValidation`, "必须是数组")
    }
  }

  // 默认 Profile
  let defaultProfile = DEFAULT_PROFILE
  if (!plan.profiles[defaultProfile]) {
    const supported = SUPPORTED_PROFILES.find((p) => plan.profiles[p])
    if (supported) defaultProfile = supported
    else {
      defaultProfile = profileNames[0]!
      push("profiles", `未声明默认 Profile（${DEFAULT_PROFILE}），回落 ${defaultProfile}`)
    }
  }

  // scriptHash 过期检测（可选）
  if (opts.scriptSource !== undefined && plan.source?.scriptHash) {
    if (hashScript(opts.scriptSource) !== plan.source.scriptHash) {
      push("source.scriptHash", "脚本内容已变化（Plan 过期，需重新分析）")
    }
  }

  return { ok: errors.length === 0, errors, defaultProfile, plan }
}
