# pi tool_call handler 返回形态错误时静默放行（安全旁路坑）

> 发现日期：2026-11-25
> 发现场景：M0 sandbox-agent-probe（dev-examples/sandbox-agent-probe/）
> 影响组件：pi 扩展 tool_call 事件拦截（pi-code-mode 权限闸门的核心机制）

## 问题现象

`pi.on("tool_call", handler)` 的 handler 返回了错误形态的对象：

```ts
// 错误写法（想象中的 API）
pi.on("tool_call", (event) => {
  return { action: "block" } as never  // 无效返回
})
```

结果：**pi 不报错、不警告，工具调用照常执行**。probe 实测 `blocked=1`（handler 确实被调用并返回了），但工具结果 `isError=false`，拦截完全没生效。

## 排查过程

1. probe B1 断言失败：handler 触发计数 blocked=1，但 toolResult isError=false。
2. 查 SDK dist/core/extensions/types.d.ts L1089 `ToolCallEventResult`，发现正确形态是：

```ts
export interface ToolCallEventResult {
  /** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
  block?: boolean
  reason?: string
  terminate?: boolean
}
```

3. `{ action: "block" }` 是 pi 其他事件 handler（如 resources_discover 的 `{ action: "transform" | "handled" }`）的结果形态，混用后 TS as never 又把类型检查关掉了。

## 根因

- pi 对 handler 返回值做宽松处理：字段不存在（`block` 为 undefined）即视为"未处理，放行"。
- `as never` 强转绕过了 TypeScript 的形态检查，编译期也不拦。

## 解决方案

```ts
pi.on("tool_call", (event) => {
  if (shouldBlock(event)) {
    return { block: true, reason: "policy: ..." }
  }
})
```

## 预防与注意事项

1. **这是安全级坑**：权限闸门返回错形态 = 无闸门且无告警。防御已双层化（v3 执行计划 M0.1）：第一层 tool_call handler 正确返回 `{ block: true, reason }`；第二层 Tool.execute 的一次性 Permit 校验（无 Permit 即拒绝真实执行）。M0.1 已实证：错误形态下 SDK 静默放行（execute 被进入），Permit 第二层拦住真实执行（entered=1 executed=0）。
2. 永远不要对 pi handler 返回值用 `as never` / `as any` 强转；让 TS 检查 `ToolCallEventResult` 形态。probe 已于 2026-11-25（M0.1）清理自身全部强转（唯一保留处是敌手模拟测试，有注释），`tsc --strict` 零错误。
3. pi 各事件 handler 的 Result 类型形态不统一（有的 `{ action: ... }`，有的裸布尔字段），写 handler 前先查 `dist/core/extensions/types.d.ts` 对应的 `XxxEventResult`。SDK `emitToolCall()` 只检查 `result.block` 字段（源码 runner.ts）。
4. 类似的静默宽松行为也存在于 `session.subscribe` 的事件结构：工具结果是 `role="toolResult"` 的顶层消息（字段 `toolName`/`isError`），不是嵌套的 `message.toolResults` 数组。
