# BUDGET-001：嵌套 workflow 并发预算未显式切分

| 元信息 | 值 |
| --- | --- |
| 规则 ID | BUDGET-001 |
| 严重度 | high |
| 置信度 | 0.85（AI 判定） |
| 检查方式 | **AI 规则检查**（需要入口 + 全部子 workflow 的嵌套并发结构，单文件 AST 无法判定） |
| 规则集版本 | 1.0 |

## 检查什么

入口并行调度子 workflow，子流程内部又动态并行，但并发预算未显式切分 → 实际在途数可能翻倍

## 为什么是问题

典型的双层并行结构：

```js
// 入口
setConcurrency(16)
const runs = await parallel([
  () => workflow({ scriptPath: './4-client-verify.js' }, { concurrency }),
  () => workflow({ scriptPath: './5-server-verify.js' }, { concurrency }),
])

// 子流程 4-client-verify.js
const results = await parallel(
  partFiles.map((p) => () => agent(...))     // 分片数运行时决定
)
```

`concurrency = 16` 传给两个子流程后，存在两种完全不同的语义：

| 语义 | 实际最大在途数 | 后果 |
| --- | --- | --- |
| **全局预算**（跨嵌套 workflow 共享一个闸门） | 16 | 符合预期 |
| **每 workflow 各自预算** | 16 + 16 = 32 | 双倍压制模型通道，限流、超时、成本翻倍 |

代码层面只传了一个数字，**没有任何地方声明它属于哪种语义**。这个问题：

- 不报错、不警告
- 单机小规模跑不出来（分片少时两层都填不满）
- 只在分片数上来之后才暴露，表现为"莫名其妙的限流/超时"

它也会让"预计波次"的计算失去意义：静态算出的波次基于 16，实际并发是 32。

## 命中判定（实现口径）

需要同时看到三层证据：

1. **入口层并行**：存在 `parallel(...)` 且其任务体调用 `workflow({ scriptPath: <子流程> })`
2. **子流程内部并行**：对应子流程源码里也存在 `parallel(<运行时集合>.map(...))`
3. **预算未切分**：满足任一
   - 入口只传一个 `concurrency` 给所有子流程，没有按端/按阶段分配（如 `clientConcurrency` / `serverConcurrency`）
   - 源码中找不到并发语义的声明（注释或配置里没有"全局共享/每 workflow 独立"的明确说明）
   - `setConcurrency()` 的取值与传入子流程的值相同，且无注释说明作用域

证据必须包含：入口并行调用位置、子流程内部并行调用位置、`concurrency` 的传递位置。

## 反例（不命中）

```js
// 显式切分 → 不命中
const BUDGET = 16
await parallel([
  () => workflow({ scriptPath: './4-client-verify.js' }, { concurrency: BUDGET / 2 }),
  () => workflow({ scriptPath: './5-server-verify.js' }, { concurrency: BUDGET / 2 }),
])
```

```js
// 子流程内不并行（纯串行）→ 不命中
// 或入口是串行调用（无 parallel 包裹）→ 不命中
```

## 报出的证据

- 入口 `parallel()` 位置 + 它调度的子 workflow 列表
- 每个子 workflow 内部 `parallel()` 位置
- `concurrency` 的取值与传递链
- 说明：无法从源码确定并发语义是全局还是每 workflow 独立

## 建议怎么改

三种改法，按优先级：

1. **显式切分预算**（最简单，兼容任何语义）：

```js
const TOTAL = 16
await parallel([
  () => workflow({ path: './4-client-verify.js' }, { concurrency: TOTAL / 2 }),
  () => workflow({ path: './5-server-verify.js' }, { concurrency: TOTAL / 2 }),
])
```

2. **确认运行时闸门作用域**：如果引擎的并发闸门本来就是 run 级全局，则在注释与文档里明确写清，并加一条运行时断言（journal 记录最大在途数）
3. **外层不并行**：双端查证如果本来就是长时间任务，外层串行 + 内层并行往往更可控（避免双层调度叠加）

## 已知误报与局限

- 无法从源码得知引擎的并发闸门作用域 → 所以这条命中是"必须确认"，不是"确定缺陷"；若确认是全局闸门，本条应视为已解决
- 子流程可能通过 `args` 动态读取并发值（`args.concurrency || 16`），实际预算取决于调用方
- 不识别更深层的三层嵌套并行（只检测两层：入口 + 直接子流程）
- `parallel` 别名（如 `await Promise.all`）不在检测范围

## 验收口径

1. 明确记录并发语义（注释/文档/配置任一）
2. Benchmark 时记录 journal 里的**最大同时在途 agent 数**，不得超过声明的预算
3. 分片数 > 预算的场景下，墙钟与 token 消耗符合"单预算"预期（而非双倍）

## 关联

- 相关规则：`03-CONC-002-rule.md`（运行时动态分片）、`02-CONC-001-rule.md`（波次估算）
- 人工审计依据：`dev-docs/troubleshooting/2026-11-19-game-requirement-audit-workflow-analysis.md` P1-006
- 真实案例：`game-requirement-audit.js` 的 S4∥S5 外层并行 + `4-client-verify.js` / `5-server-verify.js` 内部 `parallel(partFiles.map(...))`
