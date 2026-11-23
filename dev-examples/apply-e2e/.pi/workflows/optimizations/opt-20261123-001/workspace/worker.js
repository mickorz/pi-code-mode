// 端到端 apply 验证用的真实 workflow：故意带 RETRY-001 缺陷，跑得快（~20s）
export const meta = {
  id: 'apply-e2e',
  name: 'apply_e2e',
  description: 'apply/rollback 端到端验证用：故意 retries: 2，跑得快',
  phases: [{ title: '计算' }],
}

const A = args || {}
const n = Number(A.n || 1)

phase('计算')
// 缺陷：确定性任务不需要重试两次（RETRY-001）
const r = await agent(`只回复数字 ${n}`, { timeoutMs: 60000, retries: 2 })

// 写一个产物，供 verifier 校验行为一致性
const payload = { n, ok: true, reply: r }
return payload
