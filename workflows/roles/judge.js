/**
 * judge：裁决角色（独立 workflow）
 *
 * 输入 args：
 *   task       必填：任务目标
 *   materials  可选：字符串数组，上游阶段结论（如实施与评审输出的 JSON 文本）
 *   findings   可选：待裁决的 findings 数组（来自 reviewer）
 *   tier       可选：模型档位覆盖，缺省 big
 *
 * 输出：{ status, summary, findings, evidence, nextStep }
 *   status = converged | continue | escalate
 *
 * 边界：只裁决，不修改代码，不做 git 不可逆操作。
 */

export const meta = {
  id: "judge",
  name: "judge",
  description: "依据任务、变更事实与评审证据裁决通过、继续修复或升级用户决策",
}

const RESULT_SCHEMA = {
  type: "object",
  required: ["status", "summary", "findings", "evidence", "nextStep"],
  properties: {
    status: { type: "string", enum: ["converged", "continue", "escalate"] },
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

const task = (typeof args === "string" ? args : String(args?.task ?? "")).trim()
if (!task) throw new Error("judge 需要 args.task：本次裁决对应的任务目标")

const tier = String(args?.tier ?? "").trim() || "big"
const materials = Array.isArray(args?.materials)
  ? args.materials.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
  : []
const findings = Array.isArray(args?.findings) ? args.findings : []

const materialsBlock = materials.length ? materials.map((item, index) => `材料 ${index + 1}：\n${item}`).join("\n\n") : "（未提供上游结论）"
const findingsBlock = findings.length
  ? JSON.stringify(findings, null, 2)
  : "（未提供 findings；请自行检查工作区改动是否满足任务）"

const prompt = `你是 judge 角色：对已完成的改动及其评审结论做裁决。

任务目标：
${task}

上游材料：
${materialsBlock}

待裁决的 findings：
${findingsBlock}

裁决纪律：
1. 独立核实：自己读当前工作区改动、相关代码与测试，不把上游模型的说法当作事实；findings 逐条判断是否有真实依据。
2. converged：任务要求已满足且关键验证充分，summary 说明覆盖了什么、靠什么证据判断。
3. continue：存在明确、可执行、范围受限的修复项，findings 只保留经你确认的问题，每条给出可执行的 recommendation。
4. escalate：需求互相冲突、涉及产品/架构取舍、缺授权、或现有证据无法可靠判定。
5. 没有证据支撑的 finding 直接剔除，不要为了显得严格而保留臆测问题。
6. 不修改任何文件，不执行 git commit / push / merge / 发版。
7. 输出文案使用中文。

返回 JSON：
- status：converged | continue | escalate。
- summary：裁决结论与依据。
- findings：需要修复的问题（converged 时可为空数组）。
- evidence：你核实过的文件、命令与关键输出。
- nextStep：一句下一步建议。`

phase("裁决")
const result = await agent(prompt, {
  label: "judge",
  tier,
  timeoutMs: 3600000,
  schema: RESULT_SCHEMA,
})

return result
