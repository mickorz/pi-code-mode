// 期望：TIMEOUT-001 —— agent 无 timeoutMs 且无 run 级超时
await agent('分析这段代码')
await agent('复核上述结论')
return 'done'
