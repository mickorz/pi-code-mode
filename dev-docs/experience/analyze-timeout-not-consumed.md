# /workflows analyze 静默无响应：声明了 timeoutMs 却没人消费

- 日期：2026-11-19
- 影响：`/workflows analyze <脚本>` 在真实项目（PrdGameSkill）里执行后**没有任何反应**，用户以为命令没生效
- 相关文件：`src/tools/workflow-analyze-tool.ts`（`createPlannerAgent`）、`src/adapter/types.ts`（`AgentRequest`）、`src/adapter/pi-agent-adapter.ts`

---

## 问题现象

用户执行：

```
/workflows anal .opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js
```

**界面无任何输出**，长时间无响应。

## 排查过程

1. 先测静态分析本身耗时：直接调 `analyzeWorkflow({ includeSuggestions: false })` → **55ms** 完成。
   → 静态分析不慢，问题在别处。
2. 关键差异：上一轮刚把 AI 建议改成**默认开启**（`--suggest` 从显式选项变成默认行为）。
   默认路径从此会走 `createPlannerAgent()` ↔ 真实模型调用。
3. 检查 `createPlannerAgent`：它向 `AgentRequest` 传了 `timeoutMs: 180_000` 并用了 `as any`。
4. grep `timeoutMs` 在 `pi-agent-adapter.ts` 的消费点 → **0 次**。

```bash
for f in prompt model cwd tools timeoutMs signal outputSchema; do
  echo "$f: $(grep -c "request\.$f" src/adapter/pi-agent-adapter.ts)"   # timeoutMs: 0
done
```

## 根因

`AgentRequest` 声明了 `timeoutMs?: number`，但 **PiAgentAdapter 从未读取它**——超时只由 `signal`（Engine 的 `withTimeout`）驱动。

我传 `timeoutMs: 180_000` 时还用了 `as any` 强转，类型检查因此也不会报"没有这个字段的消费者"。

后果：模型调用（provider 限流、凭证异常、网络挂住）一旦不返回，`await adapter.execute()` **永久挂起**；
命令 handler 后面的 `ctx.ui.notify(summary)` 永远执行不到 → 用户看到"没有反应"。

## 为什么我自己的测试没抓到

四个失误，按严重程度排序：

1. **改默认值，却没重新验证该路径**（最严重）。
   AI 建议原本只是 `--suggest` 才走的可选分支，我的 9 条命令测试全部走默认（不调模型）。
   把默认值改成"开启"后，**未被测试覆盖的分支变成了默认路径**——这等于把一个没验过的功能推成主路径。

2. **契约测试注入的是"快乐路径 fake"**。
   测试里 `plannerAgent: async () => aiJson` 是立即返回的假函数，
   它永远不慢、不挂、不超时——只能证明"解析逻辑对"，证明不了"真实调用不会挂死"。
   缺的正是那条用例：**永不 resolve 的 fake + 断言必须超时抛错**。

3. **把"写了配置"当成"配置生效"**。
   我传了 `timeoutMs: 180_000` 就默认有超时保护，从没 grep 它在实现里有没有消费点。
   `as any` 是强信号：一旦需要 `as any` 才能传进去，就说明类型契约不匹配，必须查清原因。

4. **命令层只做了 fake ctx 单测，没做真实入口烟测**。
   我实测过 CLI（真跑通了），但 `/workflows analyze` 一次都没在真实 pi 会话里执行过。
   `ctx.ui.notify` 在 fake ctx 里是数组 push，永远不会失败、不会卡——它测不出任何交互问题。

## 解决方案

1. `createPlannerAgent` 用 `AbortController` + `setTimeout` 施加真实超时（默认 60s），超时后
   `adapter.cancel()` 清理会话；不再依赖不存在的 `timeoutMs` 字段。
2. `AgentRequest.timeoutMs` **直接删除**（死字段），并在类型注释里写明"超时只有 signal 一条通道"。
3. 命令入口先 `notify("分析中…")` 给即时反馈，避免等待期完全静默。
4. 新增守卫测试 `tests/contract/adapter-field-guard.test.ts`：
   - 断言 `AgentRequest` 每个字段在 Adapter 中至少有 `request.<field>` 消费点（防死配置）
   - 禁止用 `as any` 传 `AgentRequest` 配置
5. 新增挂起回归测试：`createPlannerAgent({ timeoutMs: 1 })` **必须抛错**而不是挂起。

## 下次如何避免（可执行清单）

写代码时：

1. **改任何默认值 = 把该路径当首次上线**。改默认前先问：这条路径有测试覆盖吗？没有就先补，再改默认。
2. **传 option 前先 grep 消费点**：
   ```bash
   grep -n "request\.<字段>\|options\.<字段>" src/adapter/*.ts
   ```
   消费点为 0 → 这个配置是假的，别信它。
3. **`as any` 视为红灯**。需要强转说明契约不匹配；要么改契约，要么说明为什么安全。

写测试时：

4. **每个"等待外部"的能力，必须有一条挂起用例**：
   fake 永远不 resolve，断言在预算时间内抛错。只有这条能证明超时存在。
5. **default 分支必须有独立用例**。可选开关 → 默认开启时，原"可选分支"的用例要变成"默认用例"，
   否则覆盖率数字没变但实际保护消失。

交付前：

6. **用户入口必须真跑一次**：命令/工具/CLI 三选一地真实验证，并保留证据（截图/输出/落盘文件）。
   fake ctx 单测不能替代入口烟测——它连"命令是否注册成功"都证明不了。
7. 长耗时操作先给反馈（进度提示），再开始等待。

## 相关

- 守卫测试：`tests/contract/adapter-field-guard.test.ts`
- 回归测试：`tests/contract/analyze-command.test.ts`（挂起保护用例）
- 同类历史问题：`dev-docs/experience/analyzer-input-001-false-positives.md`（也是"自造样本掩盖真实缺陷"）
