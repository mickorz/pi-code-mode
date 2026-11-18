// 期望：三条调用互不引用 → 依赖置信度 Candidate（可并行候选建议）
const a = await agent('分析客户端')
const b = await agent('分析服务端')
const c = await agent('分析规则')
return a + b + c
