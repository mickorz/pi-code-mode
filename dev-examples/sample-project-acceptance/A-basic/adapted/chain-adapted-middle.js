// chain 适配版中间层（pi 版）：并行两个子 workflow 再汇总
// 原版经 general 子代理调用 workflow 工具实现嵌套（opencode 宿主工具链模式）；
// pi 版子会话按契约不加载工具（防递归），嵌套统一走 workflow() 原语（引擎原生支持）
// 验证点保持不变：workflow 内并行嵌套子 workflow、prev 传递、结果合并

export const meta = { name: 'chain_adapted_middle', description: '适配版嵌套链中间层：并行两个子 workflow 再汇总' }

phase('FanOut')
log('并行启动两个叶子 workflow')
const leaves = await parallel([
  () => workflow('./chain-adapted-leaf.js', { topic: '权限系统与 permission 配置' }),
  () => workflow('./chain-adapted-leaf.js', { topic: 'session 与 message 的数据模型' }),
])

phase('Merge')
const merged = await agent(
  `下面是两份来自子工作流的分析结果，请合并为一段 3 句话的总结，并保留各自的 topic 字段：\n\n` +
  JSON.stringify(leaves, null, 2),
  { label: '中间层汇总' },
)

return { leaves, merged }
