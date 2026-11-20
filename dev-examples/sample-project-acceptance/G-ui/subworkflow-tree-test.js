// 子 workflow 嵌套执行的 Explorer 树显示验收（对齐 B-subworkflows 的 workflow() 原语嵌套）
//
// 用法（仓库根，workflow 工具 scriptPath 后台跑或交互 TUI 执行）：
//   scriptPath: ./dev-examples/sample-project-acceptance/G-ui/subworkflow-tree-test.js
// 或 run-acceptance.ts 接入后按 G-ui 清单跑。
//
// 验收点（Explorer 树 + 详情面板）：
//  1. 树层级：父 workflow（root scope）下挂 3 个子 workflow 节点（# 图标，缩进递增）
//  2. 同脚本多实例：并行 A/B 显示为两个独立节点（label 并行A/并行B 区分，不合并）
//  3. 子内 phase 前缀：子流程内 phase 显示「▸ label / 子层任务」分组
//  4. 选中子 workflow 节点：详情可见（scopePath 两层、子流程耗时）
//  5. journal 稳定性：childSeq 命名 wf0/wf1/wf2 按调用序（parallel 下不按完成序）
//
// 结构核验（headless）：journal entries 的 scopePath 嵌套关系；
// 目视核验：交互会话 Ctrl+B 打开 Explorer 查看树缩进与 # 图标。
// 确定性覆盖：tests/contract/explorer-tree.test.ts（三层嵌套/同名区分/乱序回挂）。

export const meta = { name: 'subworkflow_tree_view', description: '子 workflow 嵌套显示验收' }

const CHILD = './dev-examples/sample-project-acceptance/G-ui/subworkflow-child.js'

phase('父层')
const rootEcho = await agent('只回复一个词：root', { label: 'RootAgent', timeoutMs: 30000 })

// 串行子流程（wf0）
const serial = await workflow({ scriptPath: CHILD, label: '串行子流程' }, { tag: 'serial' })

// 并行同脚本双实例（wf1/wf2，按调用序领号不按完成序）
const [pa, pb] = await parallel([
  () => workflow({ scriptPath: CHILD, label: '并行A' }, { tag: 'parallel-a' }),
  () => workflow({ scriptPath: CHILD, label: '并行B' }, { tag: 'parallel-b' }),
])

return {
  rootEcho,
  serial,
  parallelA: pa,
  parallelB: pb,
}
