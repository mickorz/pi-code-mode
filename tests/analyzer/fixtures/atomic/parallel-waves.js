// 期望：CONC-001——任务数 48 > setConcurrency(16)，预计 3 波次
setConcurrency(16)
const groups = new Array(48).fill(0).map((_, i) => `group-${i}`)
await parallel(groups.map((g) => () => agent(`分析 ${g}`)))
