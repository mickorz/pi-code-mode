/**
 * coder：代码实施角色（独立 workflow）
 *
 * 输入 args：
 *   task       必填：要实施的任务
 *   validation 可选：字符串数组，验证命令或验收条件
 *   tier       可选：模型档位覆盖，缺省 fast
 *
 * 输出：{ status, summary, findings, evidence, nextStep }
 *   status = completed | escalate
 *
 * 边界：只改代码并验证，不做 commit / push / merge / 发版，不改全局配置。
 */

export const meta = {
  id: "coder",
  name: "coder",
  description: "按任务修改代码、运行必要验证并如实报告结果",
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
if (!task) throw new Error("coder 需要 args.task：要实施的任务描述")

const tier = String(args?.tier ?? "").trim() || "fast"
const validation = Array.isArray(args?.validation)
  ? args.validation.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
  : []

const validationBlock = validation.length
  ? validation.map((item, index) => `${index + 1}. ${item}`).join("\n")
  : "（调用方未指定，按仓库既有构建与测试纪律执行）"

const prompt = `你是 coder 角色：把已授权的任务实现为可验证的第一版代码。

任务：
${task}

验证要求：
${validationBlock}

工作纪律：
1. 先读相关代码与既有模式，理解现有实现后再改；复用既有实现，不新增无必要的抽象或依赖。
2. 直接修改当前工作区的代码，不做只给建议的纸上方案。
3. 修改 src/ 后必须先运行 npm run build，再运行相关测试；其他改动同样要跑通对应验证。
4. 不做 git commit / push / merge / 发版，不修改全局配置与模型档位配置。
5. 不用防御式代码掩盖错误：遇到问题暴露真实根因并修复，不吞异常、不静默跳过。
6. 只做任务要求范围内的改动，不做顺手重构，不添加未来可能需要的复杂度。
7. 代码注释与日志文案使用中文。

返回 JSON：
- status：completed（已实现并报告验证结果）或 escalate（缺授权、需求不清、缺必要资源或需用户决策）。
- summary：做了什么、结果如何。
- findings：任务范围内仍未解决的问题（没有就返回空数组）。
- evidence：实际执行过的命令、测试与关键文件位置。
- nextStep：一句下一步建议。`

phase("实施")
const result = await agent(prompt, {
  label: "coder",
  tier,
  timeoutMs: 3600000,
})

return parseResult(result, ["completed", "escalate"])
