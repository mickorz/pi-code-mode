/**
 * plan_validate 工具（M2-T6）：校验 Plan 文件并把 Profile 解析结果可视化
 *
 * 与 CLI `plan validate <path>` 共用同一 Core（validatePlan + resolvePlanContext）。
 */
import fs from "node:fs"
import path from "node:path"

import { Type } from "typebox"

import { loadPlan } from "../../engine/src/plan/plan-loader.js"
import { resolvePlanContext, scriptFromPlanPath } from "../../engine/src/plan/plan-runner.js"
import { hashPlan } from "../../engine/src/plan/source-fingerprint.js"

export interface ValidatePlanResult {
  ok: boolean
  /** 校验错误（带路径） */
  errors: Array<{ path: string; message: string }>
  notes: string[]
  defaultProfile?: string
  profiles?: string[]
  planHash?: string
  /** planHash 与内容是否一致 */
  hashConsistent?: boolean
  stale?: boolean
  /** 各 Profile 解析后的有效策略 */
  resolvedProfiles?: Record<string, { mode?: string; concurrency?: number; requiredValidation: boolean; additionalValidation: string[] }>
  rendered: string
}

export function validatePlanFile(input: { planPath: string; cwd?: string; scriptPath?: string; runId?: string }): ValidatePlanResult {
  const cwd = input.cwd ?? process.cwd()
  const scriptPath = input.scriptPath ?? scriptFromPlanPath(input.planPath, cwd)
  const loaded = loadPlan({
    // 推导不到脚本时用空 scriptPath（loadPlan 会跳过 stale 判定），绝不能退回 planPath
    scriptPath: scriptPath ?? "",
    cwd,
    explicitPath: input.planPath,
  })

  if (!loaded.plan) {
    return {
      ok: false,
      errors: [{ path: "", message: loaded.notes.join("; ") || "Plan 无法读取" }],
      notes: loaded.notes,
      rendered: `Plan 校验失败：${loaded.notes.join("; ")}`,
    }
  }

  const errors = loaded.validation?.errors ?? []
  const plan = loaded.plan
  const hashConsistent = plan.planHash ? hashPlan(plan) === plan.planHash : undefined

  // 各 Profile 解析视图
  const resolvedProfiles: NonNullable<ValidatePlanResult["resolvedProfiles"]> = {}
  for (const name of Object.keys(plan.profiles ?? {})) {
    const ctx = resolvePlanContext({
      ...(scriptPath ? { scriptPath } : {}),
      cwd,
      planPath: input.planPath,
      profile: name,
      runId: input.runId ?? "validate",
    })
    if (!ctx) continue
    resolvedProfiles[name] = {
      ...(ctx.policy.mode ? { mode: ctx.policy.mode } : {}),
      ...(ctx.concurrency !== undefined ? { concurrency: ctx.concurrency } : {}),
      requiredValidation: ctx.requiredValidation,
      additionalValidation: ctx.policy.additionalValidation ?? [],
    }
  }

  const lines: string[] = []
  lines.push(`# Plan 校验：${input.planPath}`)
  lines.push("")
  lines.push(`- 结果：${errors.length === 0 ? "PASS" : `FAIL（${errors.length} 个错误）`}`)
  lines.push(`- 默认 Profile：${loaded.defaultProfile}`)
  lines.push(`- Profiles：${Object.keys(plan.profiles ?? {}).join(", ")}`)
  lines.push(`- planHash 一致：${hashConsistent === undefined ? "未声明" : hashConsistent ? "是" : "**否**（Plan 被手工修改）"}`)
  lines.push(`- 脚本是否已过期：${loaded.stale ? "**是**（需重新 analyze）" : "否"}`)
  if (loaded.notes.length) {
    lines.push("")
    lines.push("## 提示")
    for (const n of loaded.notes) lines.push(`- ${n}`)
  }
  if (errors.length) {
    lines.push("")
    lines.push("## 错误")
    for (const e of errors) lines.push(`- \`${e.path}\`: ${e.message}`)
  }
  lines.push("")
  lines.push("## Profile 解析")
  for (const [name, r] of Object.entries(resolvedProfiles)) {
    lines.push(
      `- **${name}**: mode=${r.mode ?? "-"} concurrency=${r.concurrency ?? "-"} requiredValidation=${r.requiredValidation}${r.additionalValidation.length ? ` +验证[${r.additionalValidation.join(",")}]` : ""}`,
    )
  }

  return {
    ok: errors.length === 0,
    errors,
    notes: loaded.notes,
    defaultProfile: loaded.defaultProfile,
    profiles: Object.keys(plan.profiles ?? {}),
    ...(plan.planHash ? { planHash: plan.planHash } : {}),
    ...(hashConsistent !== undefined ? { hashConsistent } : {}),
    stale: loaded.stale,
    resolvedProfiles,
    rendered: lines.join("\n"),
  }
}

/** Pi 工具：plan_validate */
export function createPlanValidateTool(deps: { cwd?: string }) {
  return {
    name: "plan_validate",
    label: "Validate Workflow Plan",
    description:
      "校验 workflow 的 Plan 文件：Schema 合法性、Profile 边界（不得覆盖 Definition 强制项）、planHash 一致性、脚本是否已过期，并展示各 Profile 解析后的执行策略。",
    parameters: Type.Object({
      planPath: Type.String({ description: "Plan 文件路径（相对项目根）" }),
      scriptPath: Type.Optional(Type.String({ description: "关联脚本路径（缺省按同名推导）" })),
    }),
    async execute(_id: string, params: any) {
      const r = validatePlanFile({ planPath: params.planPath, scriptPath: params.scriptPath, cwd: deps.cwd })
      return {
        content: [{ type: "text" as const, text: r.rendered }],
        ...(r.ok ? {} : { isError: true }),
      }
    },
  }
}

/** CLI：plan validate <path> */
export function runPlanValidateCli(argv: string[]): number {
  const target = argv.find((a) => !a.startsWith("--"))
  if (!target) {
    console.error("用法：pi-code-mode plan validate <plan.json>")
    return 2
  }
  const r = validatePlanFile({ planPath: target })
  console.log(r.rendered)
  return r.ok ? 0 : 1
}
