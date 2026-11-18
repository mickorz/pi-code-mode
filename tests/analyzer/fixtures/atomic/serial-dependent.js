// 期望：依赖边 a→b→c 置信度 Explicit（真串行，不应建议并行）
const a = await agent('扫描')
const b = await agent(`复核：${a}`)
const c = await agent(`汇总：${b}`)
return c
