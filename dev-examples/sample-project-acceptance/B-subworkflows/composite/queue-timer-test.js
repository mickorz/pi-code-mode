// Bug2 修复实机验收：并发 2 下 4 个 agent——排队中的节点侧栏不显示计时（拿到槽位才开始计时）
export const meta = { name: 'queue_timer', description: '排队计时修复验收' }
phase('排队演示')
const rs = await parallel([
  () => agent('用 100 字说明文件系统目录树的概念，不要读取任何文件', { label: '慢1' }),
  () => agent('用 100 字说明软件依赖关系的概念，不要读取任何文件', { label: '慢2' }),
  () => agent('用 100 字说明软件模块划分的原则，不要读取任何文件', { label: '慢3' }),
  () => agent('用 100 字说明配置文件的作用，不要读取任何文件', { label: '慢4' }),
])
return rs.length
