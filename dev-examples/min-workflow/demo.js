// 最小 workflow 示例：用于验证 /workflows anal → run → status 三步
export const meta = {
  id: 'min-demo',
  name: 'min_demo',
  description: '最小可跑示例：一个 agent 问候 + 一个确定性返回值',
  phases: [{ title: '问候' }],
}

const A = args || {}
const who = String(A.who || '世界')

phase('问候')
// timeoutMs 必须写：否则 /workflows anal 会报 TIMEOUT-001
const greeting = await agent(`只回复一句话：你好，${who}`, { timeoutMs: 60000, retries: 0 })

return { ok: true, who, greeting }
