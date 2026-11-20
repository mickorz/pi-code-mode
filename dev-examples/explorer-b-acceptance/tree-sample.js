/**
 * Explorer B 验收脚本（根流程）
 *
 * 产出节点种类齐全的执行树，用于人工验证「单树 + 全屏详情」交互：
 *   run → workflow(root) → phase → agent（并行）
 *                       → phase → child workflow → phase → agent
 *                       → phase → composite(sequence) → agent
 *                       → phase → tool(runTool)
 *
 * 用法（在仓库根启动 pi 后）：
 *   "用 workflow 工具执行 dev-examples/explorer-b-acceptance/tree-sample.js"
 *   然后按 Ctrl+B 打开 Workflow Explorer。
 */

export const meta = { name: 'explorer_tree_sample', description: 'Explorer B 交互验收：多层执行树' }

phase('准备')
const brief = await agent(
  '用一句话说明「工作流执行观察器」的作用，不要展开。',
  { label: 'brief-writer' },
)

phase('并行采集')
const [left, right] = await parallel([
  () => agent('列出 3 个界面状态名的英文单词，逗号分隔。', { label: 'state-names' }),
  () => agent('用一句话解释「阶段」与「节点」的区别。', { label: 'phase-vs-node' }),
])

phase('子流程')
const child = await workflow(
  { scriptPath: './dev-examples/explorer-b-acceptance/child-branch.js', label: '子分支' },
  { topic: '终端侧栏' },
)

phase('组合节点')
const sequential = await sequence([
  () => agent('把「树」与「详情」两个词合成一句 12 字以内的说明。', { label: 'compose-1' }),
  () => agent('接着上一句补一个句号，不要重复内容。', { label: 'compose-2' }),
])

phase('确定性工具')
const tool = await runTool('./dev-examples/explorer-b-acceptance/probe.js', { parseJson: true })

return {
  brief,
  left,
  right,
  child,
  sequential,
  probe: tool.parsed ?? tool.stdout.trim(),
}
