/**
 * Explorer B 验收脚本（子分支）
 *
 * 被 tree-sample.js 通过 workflow({ scriptPath }) 调用，
 * 用于验证树里 child workflow 的嵌套挂载与独立 phase 前缀。
 */

export const meta = { name: 'explorer_child_branch', description: 'Explorer B 验收：子流程' }

phase('子流程内分析')
const inner = await agent(
  `围绕「${args?.topic ?? '未指定'}」说一个具体的使用场景，一句话。`,
  { label: 'child-agent' },
)
return { inner }
