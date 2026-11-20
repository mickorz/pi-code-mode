// 期望：DET-001 —— 统计类任务本可 JS 确定性完成
await agent('统计各模块的代码行数并计数', { timeoutMs: 60000 })
return 'done'
