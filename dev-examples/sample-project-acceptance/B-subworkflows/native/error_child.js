// 验收：child 业务失败直接上抛（父 try-catch 自理）
export const meta = { name: 'error_child', description: '故意抛错的子流程' }
await agent('回复固定文本：GATE-PROBE，不要使用任何工具')
throw new Error('child 业务失败：产物闸门未通过')
