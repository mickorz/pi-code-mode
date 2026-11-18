// 期望：动态分发 → Unknown
const handler = handlers[type]
await handler(input)
