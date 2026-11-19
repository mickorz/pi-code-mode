// 期望：REC-001 —— 25 个调用点且无 phase 边界（失败恢复成本高）
const rs = []
for (let i = 0; i < 25; i++) rs.push(await agent('检查模块 ' + i, { timeoutMs: 60000 }))
return rs
