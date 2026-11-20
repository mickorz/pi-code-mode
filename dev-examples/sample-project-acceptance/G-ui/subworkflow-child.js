// 子 workflow 嵌套显示验收的子脚本（被 subworkflow-tree-test.js 以三个实例引用）
// 串行 1 次 + 并行 2 次（label 区分实例，args.tag 区分业务身份）
export const meta = { name: 'subwf_child', description: '嵌套显示验收子流程' }

phase('子层任务')
const echo = await agent(
  `只回复一个词：${args.tag}`,
  { label: `EchoAgent(${args.tag})`, timeoutMs: 30000 },
)

return { ok: true, tag: args.tag, echo }
