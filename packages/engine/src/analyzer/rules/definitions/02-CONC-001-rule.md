# CONC-001：并行任务数超过并发上限（多波次）

| 元信息 | 值 |
| --- | --- |
| 规则 ID | CONC-001 |
| 严重度 | medium |
| 置信度 | 0.90（任务数全部静态可定）/ 0.50（含动态节点，为下限估算） |
| 检查方式 | AST 静态分析（并行容器内调用点 + 循环上界） |
| 规则集版本 | 1.0 |

## 检查什么

并行任务数超过并发上限 → 多波次执行（要求任务数静态可确定）

## 为什么是问题

`parallel()` 一次提交 N 个任务，运行时并发上限为 C，则分 `ceil(N/C)` 波执行。
**波次越多，长尾任务对墙钟的拖累越明显**：第 3 波必须等前两波全部结束才开始，最慢那个 agent 决定整波耗时。

## 命中判定（实现口径）

1. 源码中存在 `parallel()` 或 `pipeline()` 调用；
2. 并行容器内的 `agent()` / `workflow()` 调用点，按可确定的循环上界累加得到 `estTasks`
   （`new Array(48)`、`.map` 传播的数组字面量长度等都算可确定）；
3. `estTasks > cap`，其中 `cap = setConcurrency(n) ?? run 参数 concurrency ?? 16`。

`estTasks === 0` 直接跳过（无并行容器内容）。

命中示例：

```js
setConcurrency(16)
const groups = new Array(48).fill(0).map((_, i) => `g${i}`)
await parallel(groups.map((g) => () => agent(`分析 ${g}`)))
// → estTasks=48 > 16 → 预计 3 个波次
```

**不命中**：

```js
// ✗ 任务数 = 2 ≤ 16
await parallel([() => agent('a'), () => agent('b')])
// ✗ 分片数运行时才知道（交给 CONC-002）
await parallel(partFiles.map((p) => () => agent(p)))
```

## 报出的证据

- `并行调用点约 N 个`（含动态节点时补「估算下限」）
- `并发上限 C`
- `预计 W 个波次`

## 建议怎么改

评估分片合并（减少任务数），或提高并发上限（`setConcurrency` / run 参数，上限 16）；
波次多且单次长时，优先考虑把大任务拆成更多小任务让它们填满波次，而不是压缩并发。

## 已知误报与局限

- **只做算术，不做时序仿真**：不建模任务耗时差异，所以「3 波 ≠ 3 倍墙钟」
- 任务数含动态节点时是**下限**，真实波次可能更多（此时同时应看 CONC-002）
- 不识别运行时 `setConcurrency` 的动态改变

## 验收口径

优化后 `estTasks ≤ cap`（单波完成），或经 Benchmark 证明波次增加但墙钟未劣化（长任务变短）。

## 关联

- 实现：`src/engine/analyzer/rules/index.ts`（`concWaves`）
- 相关：`03-CONC-002-rule.md`（任务数不可确定时的兜底提示）
