/**
 * reviewer：独立代码评审角色（独立 workflow）
 *
 * 输入 args：
 *   task   必填：本次任务目标（用于判断改动是否对题）
 *   focus  可选：额外关注点，如 correctness,security
 *   base   可选：对比基线（如 main），缺省审查当前工作区改动
 *   tier   可选：模型档位覆盖，缺省 big
 *
 * 输出：{ status, summary, findings, evidence, nextStep }
 *   status = completed | escalate；findings 可为空数组
 *
 * 边界：只读评审，不修改任何文件，不做 git 不可逆操作。
 */

export const meta = {
  id: "reviewer",
  name: "reviewer",
  description: "独立审查当前工作区改动，输出带证据的可核查 findings",
}

// 常规文本输出解析：agent 不再用 schema 强约束（避免宿主修复循环的长尾延迟），
// 改为提示词要求 JSON、脚本侧宽容提取。解析失败/缺必需字段按可恢复错误上抛，不静默降级。
function parseResult(value, allowedStatus) {
  let text = value
  if (typeof text !== "string") text = JSON.stringify(text)
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error("角色输出中未找到 JSON 对象，原文开头：" + text.slice(0, 120))
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (e) {
    throw new Error("角色输出 JSON 解析失败：" + String(e?.message ?? e))
  }
  if (!parsed || typeof parsed !== "object") throw new Error("角色输出不是 JSON 对象")
  if (!allowedStatus.includes(parsed.status)) {
    throw new Error(`角色 status 非法：${JSON.stringify(parsed.status)}（允许：${allowedStatus.join(" / ")}）`)
  }
  return {
    ...parsed,
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
  }
}

const task = (typeof args === "string" ? args : String(args?.task ?? "")).trim()
if (!task) throw new Error("reviewer 需要 args.task：本次评审对应的任务目标")

const tier = String(args?.tier ?? "").trim() || "big"
const focus = String(args?.focus ?? "").trim()
const base = String(args?.base ?? "").trim()

const focusBlock = focus ? `额外关注点：${focus}` : "额外关注点：（未指定，按正确性、边界条件、复杂度、测试质量通盘检查）"
const baseBlock = base
  ? `对比基线：${base}（用 git diff 对比基线，不要只看未提交改动）`
  : "对比基线：当前工作区改动（git status 与 git diff）"

const prompt = `你是 reviewer 角色：对已完成的改动做独立代码评审。

任务目标：
${task}

${baseBlock}
${focusBlock}

评审纪律：
1. 独立核实：自己读 diff、相关调用路径、测试与任务要求，不把实施者的自评当作事实。
2. 每条 finding 必须给出 location（文件:行或函数）与 evidence（可复现的事实：代码片段、命令输出、缺失的调用点）。
3. 只报真实问题：逻辑错误、边界条件遗漏、与任务要求不符、无依据的复杂度、测试缺口或错误断言。
4. 不报纯风格偏好，不把"业界最佳实践"当作阻塞理由；没有任务依据的重构建议一律不写。
5. 没有可报问题时 findings 返回空数组，不要为了凑数虚构问题。
6. 只读：不要修改任何文件，不要执行 git commit / push / merge / 发版。
7. 输出文案使用中文。

返回 JSON：
- status：completed（已完成评审）或 escalate（缺少可比对材料、基线不可用或目标本身存在无法由评审解决的冲突）。
- summary：本次改动整体评价（一两句）。
- findings：按 severity 从高到低排列；没有就空数组。
- evidence：你实际查看过的命令、文件与关键输出。
- nextStep：一句下一步建议（例如交 judge 裁决、先补测试、先修某条问题）。`

phase("独立评审")
const result = await agent(prompt, {
  label: "reviewer",
  tier,
  timeoutMs: 3600000,
})

return parseResult(result, ["completed", "escalate"])
