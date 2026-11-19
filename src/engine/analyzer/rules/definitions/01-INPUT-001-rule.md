# INPUT-001：重复注入同一个大输入

| 元信息 | 值 |
| --- | --- |
| 规则 ID | INPUT-001 |
| 严重度 | high（`JSON.stringify` 注入且出现 ≥3 次）/ medium（其他命中） |
| 置信度 | 0.85（序列化注入）/ 0.60（只凭体积或语义名） |
| 检查方式 | AST 静态分析（标识符出现统计 + 体积判定） |
| 规则集版本 | 1.0 |

## 检查什么

同一个输入对象被多次注入不同 agent → 重复序列化与 token 浪费

## 为什么是问题

`JSON.stringify(bigObject)` 在每个 agent 的 prompt 里各展开一次，成本是 **序列化 CPU × N + token × N**。
真实案例：48 个任务共享一份 50KB 规则文档，若每个 prompt 都内联全文，光输入就是 2.4MB。

## 命中判定（实现口径）

同时满足两条才命中：

1. 同一标识符出现在 **≥2 个** `agent()` / `workflow()` 调用的参数中；
2. 满足以下**任一**体积判定：
   - 以 `JSON.stringify(<ident>)` 整体注入
   - 声明处是大数组/大对象字面量（`[...]` 或 `{...}` 内容 ≥200 字符）
   - 变量名是整体性语义名（按**整词**匹配：`requirements` / `rules` / `context` / `documents` / `contents` / `specs` / `evidence` / `items`，可带 `all`/`full` 前缀或 `Text`/`All`/`Full`/`List` 后缀）

**不命中**（这些曾导致大量误报）：

```js
// ✗ 函数名不是被注入的数据
agent('x', { label: join(a, b) })
// ✗ 对象键名不是被注入的数据
agent('x', { label: 'check' })
// ✗ 普通标识符（无体积、非语义整体名）
const filePath = 'a.md'
await agent('A: ' + filePath)
await agent('B: ' + filePath)
```

命中示例：

```js
const allRequirements = { items: new Array(50).fill('x') }   // 大对象字面量
await agent('分析' + JSON.stringify(allRequirements))
await agent('复核' + JSON.stringify(allRequirements))
await agent('终审' + JSON.stringify(allRequirements))        // → high（3 次）
```

## 报出的证据

- `标识符 \`<name>\` 在 N 个 agent/workflow 调用中出现（行 x, y, z）`
- `并以 JSON.stringify 方式整体注入（序列化开销 × N）`（仅序列化场景）

## 建议怎么改

提取为 **Shared Context 公共引用**（M4 三层上下文），任务 prompt 里只放引用而不是全文；
同时保留 **Evidence Reference 层**的原始来源（按需读取），**不要用摘要替代原文**。

## 已知误报与局限

- 无法判断标识符的真实运行时体积（只按声明形态与命名推测），所以非序列化场景置信度只有 0.60
- 不识别通过中间变量间接注入（`const a = x; agent(a)`）
- 语义名表是启发式，含业务词的新命名可能漏报

## 验收口径

优化后重跑 Analyzer：该标识符不再出现在 ≥2 个调用中，或不再以 `JSON.stringify` 注入。
质量验证：原始证据仍可按需读取（证据覆盖率不下降）。

## 关联

- 实现：`src/engine/analyzer/rules/index.ts`（`inputRepeat`）
- 经验：`dev-docs/experience/analyzer-input-001-false-positives.md`（真实仓库上的误报修复）
- 相关：M4 三层上下文（`src/engine/adaptive/context-layers.ts`）
