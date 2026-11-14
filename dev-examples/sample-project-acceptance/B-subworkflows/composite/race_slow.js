// race 慢路：单 agent 深度分析（耗时长，作为被取消方）
export const meta = { name: 'race_slow', description: 'race 慢路候选' }
phase('慢路分析')
const deep = await agent('不要使用任何工具。假设有一个"定时任务调度器"单体应用（调度主循环+关系库存储），写约 500 字的架构说明（慢慢写，写详细些）', { label: '慢路分析' })
return { lane: 'slow', deep }
