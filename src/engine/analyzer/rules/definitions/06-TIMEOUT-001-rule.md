# TIMEOUT-001：agent 调用缺少超时兜底

| 元信息 | 值 |
| --- | --- |
| 规则 ID | TIMEOUT-001 |
| 严重度 | medium |
| 置信度 | 0.75 |
| 检查方式 | AST 静态分析（`agent(` 计数 vs `timeoutMs:` 计数） |
| 规则集版本 | 1.0 |

## 检查什么

agent 调用缺少 timeoutMs 且无 run 级超时 → 单点挂起会拖垮整阶段

## 为什么是问题

一个 agent 卡在网络/模型侧不返回，没有超时就是**无限等待**：
- 整个 `parallel` 波次结束不了（波次是屏障语义）
- 后续阶段全部阻塞
- 用户看到的是"没动静"，没有任何错误信息

这类问题只能靠外部 watchdog 杀掉，代价是整 run 白跑。

## 命中判定（实现口径）

1. 源码中 `agent(` 调用数 > 0；
2. `timeoutMs:` 出现次数 = 0；
3. 且不存在 run 级超时配置（`agentTimeoutMs` 或任意 `timeoutMs:`）。

三条同时满足才报**一条**（只报首个 agent 位置）。

```js
// ✓ 命中
const a = await agent('扫描代码')
const b = await agent('复核结论')

// ✗ 不命中（有单点超时）
await agent('扫描', { timeoutMs: 600000 })

// ✗ 不命中（run 级兜底）
const runner = createRunner({ agentTimeoutMs: 3600000 })
```

## 报出的证据

- `N 个 agent 调用均未声明 timeoutMs，且无 run 级超时`

## 建议怎么改

长耗任务显式声明 `timeoutMs`（`workflow-authoring` 默认建议 `3600000` = 1 小时）：

```js
await agent(prompt, { timeoutMs: 3600000 })
```

或用 run 级配置统一兜底，避免每处都写。

## 已知误报与局限

- **粗粒度正则**：`timeoutMs:` 出现在任何位置都视为"已兜底"，包括写在注释或无关对象里
- 不区分"该 agent 是否真的长耗"（短任务不写超时风险低，但也应写）
- 不识别通过变量传入的超时（`{ ...opts }` 里含 timeoutMs）
- 一旦有任一 `timeoutMs:` 就完全不报——**覆盖式判定**，可能漏掉部分未设超时的调用

## 验收口径

每个可能长耗的 `agent()` 都有显式 `timeoutMs`，或有 run 级兜底；
人为注入一个挂起（mock 永不返回）时，workflow 能在预期时间内报超时失败而非静默挂死。

## 关联

- 实现：`src/engine/analyzer/rules/index.ts`（`timeoutMissing`）
- 经验：`dev-docs/experience/analyze-timeout-not-consumed.md`（`AgentRequest.timeoutMs` 曾是死字段，只 `signal` 生效）
- 守卫：`tests/contract/adapter-field-guard.test.ts`（断言每个 AgentRequest 字段都被消费）
- 相关：`07-RETRY-001-rule.md`
