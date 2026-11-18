// 期望：INPUT-001 HIGH——同一大对象重复注入多个 agent
const allRequirements = { items: [] }
await agent(`分析需求：${JSON.stringify(allRequirements)}`)
await agent(`复核需求：${JSON.stringify(allRequirements)}`)
await agent(`终审需求：${JSON.stringify(allRequirements)}`)
