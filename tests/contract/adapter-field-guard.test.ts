/**
 * 契约守卫：AgentRequest 的每个字段必须被 Adapter 真实消费
 *
 * 背景（2026-11-19 事故）：`createPlannerAgent` 传了 `timeoutMs: 180_000`，
 * 但 PiAgentAdapter 从未读取 request.timeoutMs —— 因为是 `as any` 传参，类型检查也不报。
 * 结果模型调用一旦挂住，`/workflows analyze` 永久静默无响应。
 *
 * 这条测试用「源码静态断言」拦住同类问题：声明在 AgentRequest 里的字段，
 * 必须在 adapter 实现中出现至少一次 `request.<field>` 消费点。
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

const ADAPTER = path.join(import.meta.dirname, "..", "..", "packages", "adapter", "src", "pi-agent-adapter.ts")
const TYPES = path.join(import.meta.dirname, "..", "..", "packages", "adapter", "src", "types.ts")

/** 从 AgentRequest 接口体里抽出字段名（只取顶层 `name?:` / `name:`） */
function requestFields(): string[] {
  const src = fs.readFileSync(TYPES, "utf8")
  const start = src.indexOf("export interface AgentRequest {")
  assert.ok(start > 0, "AgentRequest 接口应存在")
  const body = src.slice(start, src.indexOf("\n}", start))
  const fields: string[] = []
  for (const line of body.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line)
    if (m) fields.push(m[1]!)
  }
  return fields
}

test("AgentRequest 每个字段都被 PiAgentAdapter 消费（防死配置）", () => {
  const adapterSrc = fs.readFileSync(ADAPTER, "utf8")
  const fields = requestFields()
  assert.ok(fields.length >= 5, `应解析出多个字段，实际 ${JSON.stringify(fields)}`)

  const unconsumed = fields.filter((f) => {
    const re = new RegExp(`request\\??\\.${f}\\b`)
    return !re.test(adapterSrc)
  })

  assert.deepEqual(
    unconsumed,
    [],
    `以下 AgentRequest 字段在 PiAgentAdapter 中从未被读取（声明了但不生效）：${unconsumed.join(", ")}。` +
      ` 要么实现它，要么从类型里删掉——不要留“看起来能配、实际被忽略”的字段。`,
  )
})

test("禁止用 as any 传 AgentRequest 配置（审计用：记录当前违规点，防新增）", () => {
  // 该检查只针对「构造 AgentRequest 的地方」，避免新增 as any 绕过类型
  const files = [
    path.join(import.meta.dirname, "..", "..", "packages", "tools", "src", "workflow-analyze-tool.ts"),
  ]
  const offenders: string[] = []
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8")
    const lines = src.split("\n")
    lines.forEach((line, i) => {
      if (/as any\b/.test(line) && /(prompt|timeoutMs|signal|outputSchema|model)/.test(line)) {
        offenders.push(`${path.basename(file)}:${i + 1}`)
      }
    })
  }
  assert.deepEqual(offenders, [], `发现用 as any 传 AgentRequest 配置：${offenders.join(", ")}`)
})
