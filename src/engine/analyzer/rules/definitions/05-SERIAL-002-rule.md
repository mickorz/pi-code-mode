# SERIAL-002：相邻但无数据引用的调用（并行候选）

| 元信息 | 值 |
| --- | --- |
| 规则 ID | SERIAL-002 |
| 严重度 | medium |
| 置信度 | 0.70（组内全静态）/ **0.40（组内含动态或 Explicit 节点）** |
| 检查方式 | AST 静态分析（源码相邻 + 无引用） |
| 规则集版本 | 1.0 |

## 检查什么

源码相邻但无数据引用的 agent 调用 → 可并行候选（需语义确认）

## 为什么是问题

两个调用源码相邻、互相不引用对方结果，却写成串行 `await`——**可能**白等了一次往返。
但要小心：语义上可能仍有隐含顺序（写同一个文件、依赖前置副作用）。

## 命中判定（实现口径）

1. `agent()` / `workflow()` 调用在源码上**相邻**（中间没有其他调用插队）；
2. 彼此 `referencedIdentifiers` **无交集**（不构成 Explicit 依赖）；
3. 归为同组后 ≥2 个调用。

组内含动态节点或存在 Explicit 依赖时，组内置信度下调到 0.40，并在证据里追加风险说明。

```js
// ✓ 命中（相邻、无引用）
const rsPatch = await agent('更新分支状态')
const rsCards = await agent('生成卡片配置')

// ✗ 不命中（有引用，是 Explicit 依赖链）
const patch = await agent('更新分支状态')
const cards = await agent(`生成卡片：${patch}`)
```

## 报出的证据

- `N 个调用源码相邻但无数据引用（call-4, call-5, call-6）`
- 有风险时追加：`组内含动态或存在 Explicit 依赖的节点：call-5——需语义确认后才可并行化`

## 建议怎么改

**先语义确认业务独立性**，再改成 `parallel`：

```js
const [rsPatch, rsCards] = await parallel([
  () => agent('更新分支状态'),
  () => agent('生成卡片配置'),
])
```

若两者写同一个文件、或后者读取前者的副作用 → 保持串行，并在代码里注释原因。

## 已知误报与局限

- **纯静态无法判断语义独立性**：这是"Candidate 而非缺陷"的根本原因，不构成自动并行化依据
- 相邻判定按调用节点顺序，跨函数/跨文件不追踪
- 组内含 Explicit 依赖时仍会成组报出（只降置信度），需要人工排除

## 验收口径

- 优化（改并行）后：finding 消失，且 Benchmark 墙钟下降、产物与原串行版本逐字节一致
- 保持串行（语义不允许）：在代码中注释依赖原因，视为已处理

## 关联

- 实现：`src/engine/analyzer/rules/index.ts`（`parallelCandidate`）、候选分组在 `src/engine/analyzer/call-graph.ts`
- 相关：`04-SERIAL-001-rule.md`
- 报告展示：置信度 <0.5 时报告会标注「提示性，不计入风险分」
