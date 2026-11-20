# IO-001：确定性文件 IO 交给 agent

| 元信息 | 值 |
| --- | --- |
| 规则 ID | IO-001 |
| 严重度 | medium |
| 置信度 | 0.80 |
| 检查方式 | AST 静态分析（agent prompt 是否要求用 read/write 工具处理文件） |
| 规则集版本 | 1.0 |

## 检查什么

agent prompt 要求用 read/write 工具处理文件 → 确定性 IO 走了模型往返

## 为什么是问题

这类调用的本质是 `fs.readFileSync` / `fs.writeFileSync`，却走了一次完整模型往返：

| 维度 | 确定性 IO | 交给 agent |
| --- | --- | --- |
| 耗时 | 毫秒级 | 秒~分钟级（含模型思考） |
| 成本 | 0 token | 每次数万 token（文件内容进上下文） |
| 可靠性 | 逐字节确定 | 可能改写、截断、漏行、加围栏 |
| 失败定位 | 明确的 ENOENT/EACCES | 模型"读不到"然后编一个结果 |
| retry 成本 | 无意义 | 会放大 3 倍 |

真实案例（`game-requirement-audit.js`）：`readBack()` 与 `echoWrite()` 各是一个 agent 调用，
分别用于"读回 JSON 状态文件"与"把 JSON 逐字写入文件"。入口注释写明原因是"workflow 侧无 fs"——
这是宿主能力边界下的折中，但仍然应该被识别出来，因为：

1. 它的成本在高频调用时非常显著（该 workflow 里有 9 处 readBack）
2. `echoWrite` 依赖模型"逐字复制"，存在内容被改写的实质风险
3. 如果 runtime 后续提供了受治理的文件工具，这些调用点应优先迁移

## 命中判定（实现口径）

`agent(` 的第一个参数是字符串/模板字面量，且包含下列**确定性 IO 指令**之一：

| 关键词组合 | 说明 |
| --- | --- |
| `用 read 工具` / `使用 read 工具` / `read 工具读取` | 读文件 |
| `用 write 工具` / `使用 write 工具` / `write 工具写入` | 写文件 |
| `只做读取与转写` / `只做读取` | 回读器的典型自述 |
| `逐字写入文件` / `逐字复制` | 写盘器 |
| `原样返回` + `文件` | 回读语义 |

同一文件命中多处以一条 finding 汇总（列出全部行号）。

**不命中**：

```js
// ✗ 语义任务：读源码是为了理解，不是为了转写
await agent('读取 source-code/client 下的战斗模块，分析伤害计算实现是否符合 PRD')
// ✗ 文件只是路径参数，不是要求模型搬运内容
await agent(`分析 ${someFile} 的逻辑`, { tools: ['read'] })
```

## 报出的证据

- `N 处 agent 调用把确定性文件 IO 交给模型（行 x, y, z）`
- 命中的 prompt 关键词片段

## 建议怎么改

1. 若 runtime 提供受治理的 `readFile` / `writeFileAtomic`（带路径白名单、原子写、hash 校验），优先迁移
2. 无法迁移时，至少给写盘调用加**写后回读校验**（字节数 + hash），不能只信模型回话
3. 回读调用应对结果做 schema 校验，失败时报原始路径与错误，不要让模型"猜"文件内容

## 已知误报与局限

- 只看 prompt 字面量：拼接变量构造的指令（`readBack(filePath)` 这类辅助函数内部）需要在**定义处**命中，调用处不命中
- 无法判断 runtime 是否真的缺少文件能力（可能已提供但作者不知道）→ 所以 severity 是 medium 而非 high
- `只做读取与转写` 这类自述也可能出现在语义任务里（模型读完还要分析），此时是误报，需要看同段 prompt 是否有"分析/判断"要求

## 验收口径

- 改完后这些调用点不再出现，或改为确定性工具调用
- 若保留 agent 方式：写盘后回读 hash 与原内容一致；回读失败时错误信息包含具体路径与字节数

## 关联

- 实现：`src/engine/analyzer/rules/index.ts`（`deterministicIo`）
- 同类规则：`08-DET-001-rule.md`（统计/校验交给 LLM）
- 人工审计依据：`dev-docs/troubleshooting/2026-11-19-game-requirement-audit-workflow-analysis.md` P2-001
- 真实案例：`game-requirement-audit.js` 的 `readBack()` / `echoWrite()`
