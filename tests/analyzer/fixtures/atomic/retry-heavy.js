// 期望：RETRY-001 —— retries 3 放大失败成本
await agent('尝试生成', { retries: 3, timeoutMs: 60000 })
return 'done'
