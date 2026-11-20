# REC-002：恢复模式读取的收窄集合没有沿调用链传入

| 元信息 | 值 |
| --- | --- |
| 规则 ID | REC-002 |
| 严重度 | high |
| 置信度 | 0.90（跨函数变量追踪可确定） |
| 检查方式 | **AI 规则检查**（需要追踪变量在函数参数/对象属性间的传递，单文件局部 AST 无法可靠判定） |
| 规则集版本 | 1.0 |

## 检查什么

恢复模式（retry/resume/from-stage）读取的收窄集合没有沿调用链传给下游 workflow → 恢复退化为全量重跑

## 为什么是问题

恢复模式的价值全部来自"只重跑需要重跑的部分"：

- `retry`：只重跑影响集合中的原子
- `resume`：只从首个未完成阶段继续
- `from-stage`：只重跑指定起点之后

如果入口**读了**收窄集合（如 `impact-set.json` 的 `impactSet`），却**没有把它传进**真正执行的 `workflow()` / `agent()` 参数，那么子流程收到的是 `null` 或默认值：

- 子流程按全量处理 → 恢复退化成"重新跑一遍"
- 用户以为执行的是端级补证，实际墙钟与 token 成本按全量计
- 产物可能被全量结果覆盖，丢失增量语义

这类缺陷**不会报错**：代码语法正确、`null` 是合法参数、子流程自己也有默认值兜底。所以只能靠规则检查发现。

## 命中判定（实现口径）

同时满足三条才命中：

1. 代码存在恢复模式分支：出现 `mode === 'retry'` / `mode === 'resume'` / `mode === 'from-stage'`（或等价的条件判断）；
2. 该分支内**读取**了收窄集合，形态如：
   - `const impact = await readBack(...impact-set.json...)`
   - `const { impactSet } = JSON.parse(...)`
   - 访问 `impact.impactSet` / `impactSet.client` / `impactSet.server`
3. 随后传给 `workflow(...)` / `agent(...)` 的**同名参数**（`impactSet`、`retryScope`、`stageIds` 等语义对应项）**不是**上述读取值，而是：
   - 变量未赋值（如 `stageResults.impactSet`，而 `stageResults.impactSet` 在该分支从未被赋值）
   - `null` / `undefined` 兜底表达式
   - 另一个默认值常量

证据必须同时给出**读取位置**与**传递位置**两处引文。

## 反例（不命中）

```js
// 读取后正确传递 → 不命中
const impact = await readBack('...impact-set.json', ...)
const retryImpactSet = mode === 'retry' ? impact.impactSet : null
await workflow({ scriptPath }, { impactSet: retryImpactSet })

// 读取后先赋值到容器 → 不命中
impactSet: (stageResults.impactSet = impact.impactSet)
```

## 报出的证据

每条命中至少两条证据（缺一不可）：

- **读取位置**：读取 `impact-set.json` 或访问 `impactSet.client/server` 的行
- **传递位置**：`workflow(...)` / `agent(...)` 参数里使用错误来源的行

## 建议怎么改

把读取值固化成不可变常量，并在所有下游调用点显式引用，不要经过可能为空的容器：

```js
const retryImpactSet = mode === 'retry' ? impact.impactSet : null
// 所有下游调用统一用它
await workflow({ scriptPath }, { impactSet: retryImpactSet })
```

如果确实需要在多个阶段间共享，应在读取后立即赋值到容器，且保证赋值早于所有读取该容器的调用点。

## 已知误报与局限

- 只分析**显式**的参数传递；通过闭包捕获、全局变量、运行时配置注入的传递不判定
- 同名但语义不同的参数（例如另一个 `impactSet` 表示"全量影响集合"）可能误判 → 需要看读取来源是否为恢复模式的收窄文件
- 多个恢复分支共用同一容器时，需要逐分支核对，可能漏掉某一分支
- 动态构造的参数对象（`{ ...opts }`）无法静态展开 → 应给 `uncertain` 而不是 `hit`

## 验收口径

1. 构造一个含 `impact-set.json` 的 run 目录
2. 执行 `mode=retry retryScope=client startStage=S4`
3. 断言子 workflow 收到的 `impactSet.client` 与文件内容完全一致
4. 断言 `impactSet.server` 未被执行
5. journal 能证明未受影响的原子没有重新调用 agent

## 关联

- 相关规则：`09-REC-001-rule.md`（无 phase 边界导致失败只能整 run 重跑）
- 真实案例：`thirdparties/PrdGameSkill/.opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js`
  - 读取：`const impact = await readBack('...impact-set.json', ...)`
  - 传递：`impactSet: stageResults.impactSet || null`（`stageResults.impactSet` 在该分支从未赋值）
- 人工审计依据：`dev-docs/troubleshooting/2026-11-19-game-requirement-audit-workflow-analysis.md` P1-001
