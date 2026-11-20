// 期望：动态循环节点，上下界无法静态确定 → 标注 Unknown
const tasks = getTasks()
for (const task of tasks) {
  await agent(task.prompt)
}
