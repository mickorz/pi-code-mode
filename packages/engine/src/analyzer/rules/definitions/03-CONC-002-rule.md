# CONC-002：并行任务数在运行时才确定（动态分片）

| 元信息 | 值 |
| --- | --- |
| 规则 ID | CONC-002 |
| 严重度 | medium |
| 置信度 | **0.40（提示性，不计入风险分）** |
| 检查方式 | AST 静态分析（`parallel(X.map(...))` 形态） |
| 规则集版本 | 1.0 |

## 检查什么

并行任务数是运行时动态决定的分片（静态不可知，需人工确认分片数/并发/超时）

## 为什么是问题

这是**真实生产中最容易被漏掉的墙钟来源**。

PrdGameSkill S4 客户端查证的真实形态：

```js
const results = await parallel(
  partFiles.map((p) => () => agent(clientVerifyPrompt(p), withModel({
    timeoutMs: 7200000,   // 单次最长 2 小时
    retries: 2,
  })))
)
```

`partFiles` 是运行时从 manifest 读出来的：
- 分片数静态不可知 → `CONC-001` 因前提不满足而**不报**
- 于是「40 分片 × 单次最长 2 小时 ÷ 并发 16」这个真实墙钟公式，一条提示都没有
- 用户看到"风险 2/100"，误以为没问题，实际单次 run 跑 60 分钟

## 命中判定（实现口径）

正则命中 `parallel(` / `pipeline(` 的第一个参数是 **`标识符.map(...)`** 或 **`标识符.flatMap(...)`** 形态，且该标识符在声明处**不是**可静态定长的字面量：

```js
// ✓ 命中（运行时集合）
const partFiles = JSON.parse(await agent('列出分片'))
await parallel(partFiles.map((p) => () => agent(p)))

// ✓ 命中（成员访问也算）
await parallel(manifest.parts.map((p) => () => agent(p)))

// ✗ 不命中（静态可定长 → 交给 CONC-001 估波次）
const items = [1, 2, 3, 4]
await parallel(items.map((i) => () => agent(`x${i}`)))

// ✗ 不命中（new Array(N) 可定长）
const groups = new Array(48).fill(0)
await parallel(groups.map((g) => () => agent(g)))
```

## 报出的证据

三条，全部来自源码事实（**不猜分片数**）：

- `并行任务数来自运行时集合 \`<collection>\`（map），静态不可知`
- `并发上限：<n> / 未声明（运行时默认 CPU-2，上限 16）`
- `单次超时：<N>s` / `未发现 timeoutMs`

## 建议怎么改

确认三件事：

1. **分片数**（决定波次数，通常等于需求分片/阶段数）
2. **并发上限**是否匹配（`setConcurrency` 或 run 参数）
3. **单次超时**是否够（不够会大面积失败重试，过大则挂死拖整阶段）

分片多 + 单次长 → 必然多波次长尾；考虑合并分片、或按 `stageIds` 缩小范围分次跑。

## 已知误报与局限

- **confidence 0.40 刻意低于计分阈值 0.50**：它不增加风险分，只是"必须人工确认"的检查清单
- 无法知道分片数，所以给不出波次估算（**不编造数字**）
- 集合经多级传递（`const a = b; parallel(a.map(...))`）时不命中——只识别一层
- 集合是可静态定长的变量时主动让位给 CONC-001，避免重复提示

## 验收口径

人工确认后的结论二选一：
- 分片数 ≤ 并发上限 → 单波，无需改动
- 分片数 > 并发上限 → 用 Benchmark 确认是否接受多波次；不接受则调并发/合并分片

## 关联

- 实现：`src/engine/analyzer/rules/index.ts`（`dynamicParallel`）
- 经验：`dev-docs/experience/analyzer-single-file-misses-subworkflows.md`（发现过程：聚合后仍漏掉这个盲区）
- 相关：`02-CONC-001-rule.md`（任务数可确定时的波次估算）
