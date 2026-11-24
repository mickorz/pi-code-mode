// 端到端 apply 验证用：故意带 RETRY-001 与 IO-001 两个缺陷（多簇 → 必有一个 skipped）
export const meta = {
  id: 'apply-e2e',
  name: 'apply_e2e',
  description: 'apply/rollback 端到端验证用：故意 retries: 2，跑得快',
  phases: [{ title: '计算' }],
}

const A = args || {}
const n = Number(A.n || 1)

phase('计算')
// 缺陷 RETRY-001：确定性任务不需要重试两次
const r = await agent(`只回复数字 ${n}`, { timeoutMs: 60000, retries: 2 })

// 缺陷 IO-001：让模型用 read 工具读文件（确定性 IO 交给模型）
const back = await agent('你是文件回读器，只做读取与转写，不做解读。任务：用 read 工具读取 a.json 并原样返回。', {
  timeoutMs: 60000,
  retries: 2,
})

return { n, ok: true, reply: r, back }
