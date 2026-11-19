# SERIAL-001：长数据依赖链（≥3 个串行调用）

| 元信息 | 值 |
| --- | --- |
| 规则 ID | SERIAL-001 |
| 严重度 | low |
| 置信度 | 0.95（依赖边是 Explicit，静态确定） |
| 检查方式 | AST 静态分析（Explicit 依赖边构成的链） |
| 规则集版本 | 1.0 |

## 检查什么

多个 agent 构成明确数据依赖链（合理串行，但可能是墙钟瓶颈）

## 为什么是问题

**这条不是缺陷判定，是墙钟提示。** 依赖链无法并行，所以总耗时 = 各环节耗时之和。
链越长，越容易成为整个 workflow 的墙钟主导项（真实案例：8 段阶段串行，单段最长 59 分钟）。

## 命中判定（实现口径）

1. 依赖边置信度为 **Explicit**（后者参数引用了前者的结果变量）；
2. 沿 Explicit 边归并出链；
3. **链长度 ≥3** 才报（2 个调用的链太常见，报了是噪声）。

```js
// ✓ 命中：A → B → C 三环 Explicit 链
const a = await agent('扫描')
const b = await agent(`复核：${a}`)
const c = await agent(`汇总：${b}`)

// ✗ 不命中：只有 2 个调用
const spec = await workflow('./1-spec.js')
const design = await workflow('./2-design.js', { brief: spec.brief })
```

## 报出的证据

- `N 个调用构成 Explicit 数据依赖链（call-1 → call-2 → call-3）`

## 建议怎么改

**不要试图并行化**（有真实数据依赖）。提速方向：

1. 缩短单次耗时（缩小 prompt 输入、降低输出要求）
2. 拆分任务粒度（把一个大 agent 拆成多段可流水线的细粒度任务）
3. 把链上可并行的分支提取出来（例：B 中不依赖 A 的部分先跑）

## 已知误报与局限

- 只识别**变量直接引用**构成的 Explicit 链；通过中间对象改写（`obj.x = a`）不追踪
- 链的归并取首个后继（分叉时会拆成多条链，可能低估真实长度）
- 不区分"必要的业务串行"与"可流水线的串行"（后者需语义判断）

## 验收口径

不需要"消除"该 finding——它是结构性事实。
验收看：优化后链上单点耗时是否下降（Benchmark 对比墙钟），而非 finding 是否消失。

## 关联

- 实现：`src/engine/analyzer/rules/index.ts`（`serialChain`）、链归并在 `src/engine/analyzer/call-graph.ts`
- 相关：`05-SERIAL-002-rule.md`（无依赖相邻调用的并行候选）
