// 验收：自环拒绝（child 调用自身）
export const meta = { name: 'self_ref', description: '自环拒绝验收' }
await agent('回复固定文本：STEP-1，不要使用任何工具')
return await workflow('./self_ref.js')
