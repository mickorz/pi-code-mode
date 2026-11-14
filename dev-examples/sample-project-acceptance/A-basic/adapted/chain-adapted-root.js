// chain 适配版根（pi 版）：三层嵌套链根
// 验证点与原版 chain-root.js 一致：root -> middle -> leaf x2 完整嵌套链路
// （journal 应出现 3 个子 workflow invocation：middle 1 个 + leaf 2 个）

export const meta = { name: 'chain_adapted_root', description: '适配版嵌套链根：串联 middle 与 leaf 两层子 workflow' }

phase('Launch')
log('启动中间层子 workflow（其内部将再嵌套两个叶子）')
const middle = await workflow('./chain-adapted-middle.js')

phase('Report')
const report = await agent(
  `以下是一次三层嵌套工作流（root -> middle -> 两个并行 leaf）的产出，请用 3 句话总结核心结论：\n\n` +
  JSON.stringify(middle, null, 2),
  { label: '根汇总' },
)

return { middle, report }
