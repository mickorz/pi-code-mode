// 验收：深度限制（child 内再调一层 child）
export const meta = { name: 'deep_child', description: '深度限制验收' }
await agent('用一句话说明什么是函数嵌套调用，不要使用任何工具')
return await workflow('./1_spec.js')
