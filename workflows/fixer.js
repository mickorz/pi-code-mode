/**
 * fixer：问题修复角色（独立 workflow）
 *
 * 输入 args：
 *   task       必填：任务目标（提供上下文，避免修偏）
 *   findings   必填：待修复的 findings 数组（来自 judge）
 *   validation 可选：字符串数组，验证命令或验收条件
 *   tier       可选：模型档位覆盖，缺省 fast
 *
 * 输出：{ status, summary, findings, evidence, nextStep }
 *   status = completed | escalate
 *
 * 边界：只处理已确认的 findings，不做 commit / push / merge / 发版，不改全局配置。
 */

export const meta = {
  id: "fixer",
  name: "fixer",
  description: "按已确认的 findings 在根因处修复并重新验证",
}

const RESULT_SCHEMA = {
  type: "object",
  required: ["status", "summary", "findings", "evidence", "nextStep"],
  properties: {
    status: { type: "string", enum: ["completed", "escalate"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "location", "evidence", "recommendation"],
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          location: { type: "string" },
          evidence: { type: "string" },
          recommendation: { type: "string" },
        },
      },
    },
    evidence: { type: "array", items: { type: "string" } },
    nextStep: { type: "string" },
  },
}

const task = String(args.task ?? "").trim()
if (!task) throw new Error("fixer 需要 args.task：本次修复对应的任务目标")

const findings = Array.isArray(args.findings) ? args.findings : []
if (!findings.length) throw new Error("fixer 需要 args.findings：待修复的问题清单（来自 judge 裁决）")

const tier = String(args.tier ?? "").trim() || "fast"
const validation = Array.isArray(args.validation)
  ? args.validation.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
  : []

const validationBlock = validation.length
  ? validation.map((item, index) => `${index + 1}. ${item}`).join("\n")
  : "（调用方未指定，按仓库既有构建与测试纪律执行）"

const prompt = `你是 fixer 角色：只修复下列已确认的问题，在根因处一次修净。

任务背景：
${task}

待修复的 findings：
${JSON.stringify(findings, null, 2)}

验证要求：
${validationBlock}

修复纪律：
1. 只处理上面列出的 findings，不顺手扩大范围、不做无关重构。
2. 在根因处修复，不做补丁式掩盖；优先删除、简化、复用既有实现，而不是新增抽象或依赖。
3. 修复已失效的旧实现要一并清理，不留双路径与死代码。
4. 直接修改当前工作区；修改 src/ 后必须先运行 npm run build，再运行相关测试。
5. 不做 git commit / push / merge / 发版，不修改全局配置与模型档位配置。
6. 若某条 finding 需要用户做产品/架构决策，或前提不成立，直接 escalate 并写明原因，不要臆测实现。
7. 输出文案使用中文。

返回 JSON：
- status：completed（已修复并报告验证结果）或 escalate（需要用户决策或前提不成立）。
- summary：逐条说明改了什么、结果如何。
- findings：仍未解决的问题（没有就空数组）。
- evidence：实际执行过的命令、测试与关键文件位置。
- nextStep：一句下一步建议。`

phase("修复")
const result = await agent(prompt, {
  label: "fixer",
  tier,
  timeoutMs: 3600000,
  schema: RESULT_SCHEMA,
})

return result
