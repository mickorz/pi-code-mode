/**
 * quality-loop：默认质量闭环（组合 workflow，纯编排，自身不调模型）
 *
 * 拓扑：coder -> reviewer -> judge ->（judge=continue 时）fixer -> reviewer -> judge
 *
 * 前置：按注册名调用角色（内置角色随包分发，无需注册）。
 *
 * 输入 args：
 *   task            必填：任务目标
 *   validation      可选：字符串数组，验证命令或验收条件
 *   maxRepairRounds 可选：修复轮数上限，1（缺省）或 2
 *   coderTier       可选：缺省 fast
 *   reviewerTier    可选：缺省 big
 *   judgeTier       可选：缺省 big
 *   fixerTier       可选：缺省 fast
 *
 * 输出：{ status, summary, roundsCompleted, nextStep, stages }
 *   status = converged | continue | escalate
 *
 * 边界：不 commit / push / merge / 发版；不可逆动作始终留给调用者。
 */

export const meta = {
  id: "quality-loop",
  name: "quality_loop",
  description: "coder -> reviewer -> judge 的默认质量闭环，continue 时按上限修复后复审复裁",
}

const task = (typeof args === "string" ? args : String(args?.task ?? "")).trim()
if (!task) throw new Error("quality-loop 需要 args.task：要完成的任务描述")

const tierOf = (value, fallback) => String(value ?? "").trim() || fallback

const coderTier = tierOf(args?.coderTier, "fast")
const reviewerTier = tierOf(args?.reviewerTier, "big")
const judgeTier = tierOf(args?.judgeTier, "big")
const fixerTier = tierOf(args?.fixerTier, "fast")

const maxRepairRounds = args?.maxRepairRounds === 2 ? 2 : 1
const validation = Array.isArray(args?.validation)
  ? args.validation.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
  : []

const reviews = []
const judgments = []
const repairs = []

const finish = (status, summary, nextStep) => ({
  status,
  summary,
  roundsCompleted: judgments.length,
  nextStep,
  stages: { implementation, reviews, judgments, repairs },
})

phase("实施")
const implementation = await workflow("coder", { task, validation, tier: coderTier })

if (implementation.status === "escalate") {
  return finish("escalate", implementation.summary, "实施阶段升级：请先给出用户决策或补齐前置条件")
}

let round = 0
while (true) {
  round += 1

  phase(`独立评审（第 ${round} 轮）`)
  const review = await workflow("reviewer", { task, tier: reviewerTier })
  reviews.push(review)
  if (review.status === "escalate") {
    return finish("escalate", review.summary, "评审阶段升级：请先补齐可比对材料或解决目标冲突")
  }

  phase(`裁决（第 ${round} 轮）`)
  const judgment = await workflow("judge", {
    task,
    materials: [JSON.stringify(implementation), JSON.stringify(review)],
    findings: review.findings,
    tier: judgeTier,
  })
  judgments.push(judgment)

  if (judgment.status === "converged") {
    return finish("converged", judgment.summary, "由调用者检查变更并决定是否提交或合并")
  }
  if (judgment.status === "escalate") {
    return finish("escalate", judgment.summary, "裁决升级：请先做产品/架构决策或补齐授权")
  }

  if (round > maxRepairRounds) {
    return finish(
      "continue",
      `已达修复轮数上限（${maxRepairRounds} 轮），仍有待修问题：${judgment.summary}`,
      "人工处理 findings 后重新运行 quality-loop",
    )
  }

  phase(`修复（第 ${round} 轮）`)
  const repair = await workflow("fixer", {
    task,
    findings: judgment.findings,
    validation,
    tier: fixerTier,
  })
  repairs.push(repair)
  if (repair.status === "escalate") {
    return finish("escalate", repair.summary, "修复阶段升级：请先给出用户决策或补齐前置条件")
  }
}
