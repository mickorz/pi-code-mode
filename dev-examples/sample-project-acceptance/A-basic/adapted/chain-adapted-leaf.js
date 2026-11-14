// chain 适配版叶子（pi 版）：单 agent 主题要点分析（纯生成，不读 docs）
// 原版 chain-leaf.js 依赖子代理读 sample-project/docs；适配版保持 args 传参与结构化返回语义不变
// 验证点：被嵌套执行的 workflow 自身正常完成 run 并返回结构化结果

export const meta = { name: 'chain_adapted_leaf', description: '适配版嵌套链叶子：单 agent 主题要点分析' }

// 上层经 args 下发主题；直接单独跑也有缺省值
const topic = args?.topic ?? '工作流插件的 tool 注册机制'

const text = await agent(
  `围绕主题「${topic}」给出 3 句以内的要点总结，不要使用任何工具。`,
  { label: `叶子:${String(topic).slice(0, 12)}` },
)

return { topic, leafSummary: text }
