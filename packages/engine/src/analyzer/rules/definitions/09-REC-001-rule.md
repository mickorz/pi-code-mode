# REC-001：大规模任务但无阶段边界

| 元信息 | 值 |
| --- | --- |
| 规则 ID | REC-001 |
| 严重度 | high |
| 置信度 | 0.80（任务数全部静态可定）/ 0.50（含动态节点，为下限） |
| 检查方式 | AST 静态分析（估算任务量 + `phase(` 计数） |
| 规则集版本 | 1.0 |

## 检查什么

大规模任务且无 phase 边界 → 失败后只能整 run 重跑

## 为什么是问题

一个 48 任务、跑 60 分钟的 workflow，第 45 个任务失败时：

- **有 phase 边界** + TaskCheckpoint：已完成任务从 journal 复用，只重跑失败的那个
- **无 phase 边界**：要么整 run 重跑（1 小时白花），要么手工拼 `resumeFromRunId` 前缀回放（易错）

这是**成本最高的规则**（hign），因为代价直接是墙钟与 token 的成倍浪费。

## 命中判定（实现口径）

1. 用 `estimateTaskCount()` 估算任务量：循环上界可定按上界累加，动态节点按 1（下限）；
2. `total >= 20`；
3. 源码中 `phase(` 出现次数 = 0。

```js
// ✓ 命中（48 个任务，无 phase）
const groups = new Array(48).fill(0)
await parallel(groups.map((g) => () => agent(`处理 ${g}`)))

// ✗ 不命中（有 phase 边界）
await phase('扫描', async () => { ... })
await phase('查证', async () => { ... })

// ✗ 不命中（任务量 < 20）
await parallel([a, b, c].map(...))
```

## 报出的证据

- `估算任务量 N（≥20）且无 phase 阶段边界`
- `无阶段边界时失败后只能整 run 重跑或依赖 journal 前缀回放`

含动态节点时任务量标注「下限」，confidence 降到 0.50。

## 建议怎么改

用 `phase()` 划分阶段边界，配合 M3 `TaskCheckpoint` 实现任务级恢复：

```js
await phase('扫描', async () => { /* ... */ })
await phase('查证', async () => { /* ... */ })
```

失败后：`/workflows resume <runId> --tasks` 只重跑失败任务。

## 已知误报与局限

- `phase(` 用正则计数，写在注释里也算（可能漏报）
- 任务量是**估算**：`estimateTaskCount` 只用单层循环上界，嵌套循环会低估
- **动态分片不计入规模**（实测确认）：`parallel(parts.map(...))` 里 parts 来自运行时，
  `estimateTaskCount` 只把该 agent 记为 1，所以 48 个分片会被当成 1 个任务 → `total < 20` → 本条**漏报**。
  这类场景的墙钟风险由 `CONC-002` 提示（分片数静态不可知，需人工确认三件事），
  信息不丢失，但不要指望 REC-001 给出结论。
- 不检查是否真的启用了 TaskCheckpoint（有 phase 但没开 checkpoint 时恢复能力仍受限）

## 验收口径

1. 有 `phase()` 边界；
2. 人为让第 N 个任务失败，`resume --tasks` 能只重跑失败任务，已完成任务 0 次重复调用（journal 可证）。

## 关联

- 实现：`src/engine/analyzer/rules/index.ts`（`recoveryRisk`）、任务量估算（`estimateTaskCount`）
- 相关：M3 任务级恢复（`src/engine/governance/task-registry.ts`）、`/workflows resume --tasks`
- 经验：`dev-docs/experience/analyzer-single-file-misses-subworkflows.md`
