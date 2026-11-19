# game-requirement-audit 分析能力升级执行计划

- 计划日期：2026-11-19
- 目标：让 `/workflows anal` 对真实入口
  `thirdparties/PrdGameSkill/.opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js`
  进行完整的静态分析与默认 AI Rule Check，并生成数据一致的 Markdown 报告、HTML Dashboard。
- 参考：
  - `dev-docs/troubleshooting/2026-11-19-analysis-dashboard-vs-manual-audit-gap.md`
  - `dev-docs/troubleshooting/2026-11-19-game-requirement-audit-workflow-analysis.md`
  - `thirdparties/PrdGameSkill/.claude/skills/game-prd-check/SKILL.md`

---

## 一、现状与根因

当前分析链路是：

```text
静态 Analyzer
  → 生成 finding
  → Planner AI 只读取 finding 摘要
  → 针对已有 finding 给优化建议
  → Markdown / Dashboard
```

当前 Planner prompt 明确要求：

```text
仅基于下面的静态分析摘要提建议，不要重新分析项目
```

因此当前 AI 不是 Rule Checker，无法独立发现：

- retry 影响集合没有传入子 workflow
- 阶段输入校验范围过宽
- 外层与内层 workflow 并发预算不明确
- `readBack` / `echoWrite` 将确定性 IO 交给 agent
- 文件副作用、锁竞争、manifest 覆盖
- 跨文件恢复数据流问题

同时存在报告口径问题：

- Dashboard 已展示聚合后的 12 文件 / 23 finding。
- Markdown 的规则清单仍主要使用入口自身 `ruleInventory`，显示为 `RETRY-001 命中 1`、`CONC-002 通过`、`SERIAL-002 通过`。
- 同一次分析的 Markdown、JSON、Dashboard 不是同一份最终聚合模型。

---

## 二、总体目标架构

```text
阶段一：Source Discovery
  入口文件 + 子 workflow 文件 + 文件关系 + 规则文档

阶段二：Static Analyzer
  AST / 调用图 / 局部确定性规则 / 跨文件结构摘要

阶段三：AI Rule Checker（默认开启）
  每条 rule.md + 相关源码 + 静态证据
  → pass / hit / uncertain / not-applicable
  → 文件 / 行号 / 引文 / 原因 / 置信度 / 验证方式

阶段四：Evidence Validator
  校验 ruleId、文件、行号、quote 是否真实存在
  无法核对的 AI 结果丢弃并记录 diagnostic

阶段五：Aggregate Merger
  entry + subtree + static + ai
  → 统一 AggregateAnalysisReport

阶段六：输出
  AggregateAnalysisReport
    → Markdown
    → JSON
    → HTML Dashboard

阶段七：真实场景验收
  game-requirement-audit.js
  → 检查报告和 Dashboard 一致性
```

核心原则：

1. 静态检查保留，结构事实不交给模型猜测。
2. AI 默认参与 rule check，不再只做 Planner。
3. Planner 作为 Rule Check 之后的独立建议阶段，不与 Rule Checker 混用。
4. Markdown、JSON、Dashboard 只消费同一个最终聚合模型。
5. 所有 AI finding 必须有可校验证据。
6. AI 超时或失败仍生成完整静态报告，并明确标注 AI 检查未完成。

---

## 三、阶段拆解

# P0：统一报告数据模型与聚合口径

## P0-1 定义最终聚合模型

### 目标

解决入口 findings、子 workflow findings、规则命中数、严重度统计不一致的问题。

### 修改文件

- `src/engine/analyzer/report-builder.ts`
- `src/engine/analyzer/tree-analyzer.ts`
- `src/tools/workflow-analyze-tool.ts`
- 新增或修改 `src/engine/analyzer/aggregate-report.ts`

### 建议数据结构

```ts
interface AggregateAnalysisReport {
  schemaVersion: "2.0"
  entry: {
    file: string
    findings: AnalysisFinding[]
    ruleInventory: RuleInventoryItem[]
    summary: AnalysisSummary
  }
  subtree: {
    files: number
    callSites: number
    findings: AnalysisFinding[]
    ruleInventory: RuleInventoryItem[]
    summary: AnalysisSummary
    workflows: SubWorkflowSummary[]
  }
  aggregate: {
    findings: AnalysisFinding[]
    ruleInventory: RuleInventoryItem[]
    summary: AnalysisSummary
  }
  ai?: {
    enabled: boolean
    status: "completed" | "partial" | "failed" | "skipped"
    ruleChecks: AIRuleCheck[]
    diagnostics: string[]
  }
  recommendations: Recommendation[]
}
```

### 必须明确的口径

| 字段 | 口径 |
|---|---|
| `entry.findings` | 入口文件自身 findings |
| `subtree.findings` | 子 workflow findings，不含入口 |
| `aggregate.findings` | 入口 + 子 workflow，去重后结果 |
| `aggregate.ruleInventory` | 9 条规则在所有文件上的执行结果和命中数 |
| `aggregate.summary` | 由 aggregate findings 重新计算 |
| `riskScore` | 明确是入口风险、最高单文件风险，还是聚合风险；禁止混用 |

### 验收标准

- 真实入口同时显示：入口 1 条、子流程 22 条、聚合 23 条。
- Markdown、JSON、Dashboard 的 finding 数和规则命中数完全一致。
- `CONC-002` 不再出现 Dashboard 命中、Markdown 通过的矛盾。

---

## P0-2 修复 Markdown 报告

### 修改文件

- `src/engine/analyzer/report-builder.ts`

### Markdown 结构

```md
# Workflow Analysis

## 1. 分析范围
- 入口文件
- 子 workflow 文件数
- 分析模式：静态 / AI Rule Check / Planner

## 2. 总体统计
- 入口 findings
- 子 workflow findings
- 聚合 findings
- 风险分口径

## 3. Rule 检查总表
| Rule | 检查来源 | 静态结果 | AI 结果 | 最终结果 | 命中数 |

## 4. 聚合问题列表
| ID | 来源 | Rule | 严重度 | 位置 | 置信度 | 状态 |

## 5. 问题详情
- 静态 finding
- AI finding
- 引文
- 代码片段
- 影响
- 建议
- 验证条件

## 6. AI Rule Check 详情
每条 rule 的 pass/hit/uncertain/not-applicable 原因

## 7. Planner 优化建议
只放优化建议，不伪装成 rule check
```

### 关键区分

- `[STATIC]`：程序规则产生。
- `[AI-RULE]`：AI 依据 rule 文档产生。
- `[BOTH]`：静态与 AI 都确认。
- `[CONFLICT]`：静态与 AI 结论不一致。
- `[UNCERTAIN]`：AI 需要人工确认。

---

# P1：实现 AI Rule Checker

## P1-1 定义 AI Rule Check 数据契约

### 新增类型

建议新增：

```ts
interface AIRuleCheck {
  ruleId: string
  status: "hit" | "pass" | "uncertain" | "not-applicable" | "error"
  confidence: number
  source: "ai"
  files: string[]
  evidence: Array<{
    file: string
    startLine: number
    endLine: number
    quote: string
  }>
  reason: string
  impact?: string
  suggestion?: string
  validation?: string[]
}
```

### AI 输出硬约束

1. `ruleId` 必须来自 `BUILTIN_RULES`。
2. 每个 `hit` 必须有至少一个 evidence。
3. 每个 evidence 必须包含文件、起始行、结束行和 quote。
4. `confidence < 0.5` 时最终状态只能是 `uncertain`，不能计入风险分。
5. 不允许 AI 输出具体收益数字，除非输入包含 Benchmark 基线。
6. AI 不得修改源码，只输出检查结果。

---

## P1-2 加载 rule 文档

### 修改文件

- 新增 `src/engine/analyzer/ai-rule-checker/rule-doc-loader.ts`
- 规则文档目录：`src/engine/analyzer/rules/definitions/`

### 功能

- 根据 `BUILTIN_RULES` ID 找到对应 `NN-<ID>-rule.md`。
- 校验每份文档存在且文件名 ID 正确。
- 读取规则全文。
- 缓存同一次分析中的规则文档，避免重复 IO。
- 将规则文档版本、文件名写入 AI 请求元数据。

### 验收

- 9 条规则全部加载。
- 缺少一个规则文档时 AI Rule Check 不静默继续，报告 diagnostic 明确指出。
- 规则文档与 `description` 守卫继续通过。

---

## P1-3 构造 AI Rule Check Prompt

### 修改文件

- 新增 `src/engine/analyzer/ai-rule-checker/prompt-builder.ts`
- 新增 `src/engine/analyzer/ai-rule-checker/ai-rule-checker.ts`

### Prompt 输入

```text
任务：按规则文档检查 workflow 源码，不是给泛化优化建议。

规则文档：
<单条或规则组的 md 全文>

入口源码：
<入口源码或相关片段>

子 workflow 源码：
<与该规则相关的文件>

静态提示：
<AST、调用图、已有 findings、unknowns>

要求：
- 只依据 rule 文档判断
- 不确定就 uncertain
- 每个 hit 必须带文件、行号和原文 quote
- 不得编造源码中不存在的证据
- 只输出 JSON
```

### 执行策略

第一版不把 9 条规则拆成 9 次模型调用，避免：

- 9 倍模型等待时间
- 9 倍输入 token
- 规则间无法共享上下文

建议分成 3 组：

| 组 | 规则 | 原因 |
|---|---|---|
| 输入与确定性 | `INPUT-001`、`DET-001`、`TIMEOUT-001`、`RETRY-001` | 共享 agent 调用和 prompt 信息 |
| 并发与串行 | `CONC-001`、`CONC-002`、`SERIAL-001`、`SERIAL-002` | 共享调用图和并发结构 |
| 恢复与治理 | `REC-001` + 新增 `REC-002`、`IO-001`、`BUDGET-001`、`INPUT-002` | 需要入口与子 workflow 的跨文件上下文 |

AI 调用可并行，但要设置最大并发 2，符合项目真实模型联调约束。

### 重要取舍

- 第一版优先对“高价值语义规则”启用 AI：`SERIAL-002`、`CONC-002`、`REC-002`、`IO-001`、`BUDGET-001`。
- `TIMEOUT-001`、`RETRY-001` 等结构事实仍由静态规则作为主判定，AI 只负责检查语义例外。
- 不要让 AI 覆盖静态事实。

---

## P1-4 证据校验器

### 新增文件

- `src/engine/analyzer/ai-rule-checker/evidence-validator.ts`

### 校验规则

```text
ruleId 存在
  → file 在本次 source set
  → startLine/endLine 在文件范围内
  → quote 能在指定行范围或附近源码中匹配
  → status=hit 时 evidence 非空
  → confidence 在 0..1
```

### 失败处理

- 单条 AI finding 校验失败：丢弃该 finding，保留 diagnostic。
- 整个 AI 输出 JSON 无法解析：该规则组状态 `error`。
- AI 超时：该规则组状态 `error`，不阻断静态报告。
- AI 与静态冲突：两者都保留，最终状态 `conflict`，不得静默覆盖。

---

## P1-5 合并静态与 AI 结果

### 新增文件

- `src/engine/analyzer/ai-rule-checker/result-merger.ts`

### 合并逻辑

| 静态 | AI | 最终 |
|---|---|---|
| hit | hit | both，合并证据 |
| hit | pass | conflict，不覆盖静态事实 |
| pass | hit | ai，等待证据/人工确认 |
| pass | pass | pass |
| pass | uncertain | uncertain |
| error | 任意 | error + 保留另一侧结果 |

### 风险计分

- 静态结构事实：按现有权重计分。
- AI `confidence >= 0.7` 且 evidence 校验通过：可以进入候选风险，但建议第一版不直接增加总风险分，只单独显示 AI 风险。
- AI `confidence < 0.7`：只显示为 uncertain，不进入主风险分。
- Dashboard 显示：`静态风险分`、`AI 风险提示数`、`最终需人工确认数` 三个指标，避免把模型判断伪装成确定风险。

---

# P2：补跨文件静态规则

## P2-1 REC-002：retry 影响集合传递完整性

### 目标

检查 retry 分支读取的影响集合是否真正传入子 workflow。

### 检查路径

```text
mode === retry
  → impact = readBack(impact-set.json)
  → impact.impactSet
  → runStage / workflow 参数 impactSet
```

### 当前真实问题

入口读取了 `impact.impactSet`，但 `runStage()` 使用：

```js
impactSet: stageResults.impactSet || null
```

静态规则应报：

```text
REC-002 hit
retry 读取的 impact.impactSet 没有沿调用链传入 S4/S5
```

### 实现要求

- 支持跨函数变量追踪。
- 支持简单属性传播。
- 支持 `mode` 分支条件。
- 至少输出起点和终点两个证据位置。

---

## P2-2 IO-001：确定性 IO 代理风险

检查以下模式：

- `readBack()` 中使用 agent 读取 JSON。
- `echoWrite()` 中使用 agent 写文件。
- workflow 运行时是否已有安全的文件工具可替代。

AI 可做语义确认，但静态规则负责发现调用模式。

---

## P2-3 BUDGET-001：嵌套 workflow 并发预算

检查：

- 入口 `parallel(S4, S5)`。
- 子 workflow 内部 `parallel(partFiles.map(...))`。
- `concurrency` 是否显式切分。
- 是否存在全局共享预算参数。

输出应至少包含：

- 外层并发节点
- 内层并发节点
- 预算变量
- 未知点

---

## P2-4 INPUT-002：阶段输入校验范围

检查：

- S4 是否只校验客户端输入。
- S5 是否只校验服务端输入。
- retryScope 是否限制校验范围。
- from-stage 是否继续校验已完成阶段的输入。

---

## P2-5 SIDEFX-001：并行候选共享副作用

检查 SERIAL-002 候选调用是否：

- 写入相同文件。
- 读取同一份将被前序调用修改的文件。
- 使用同一 `runDir` 子路径。
- 使用相同临时文件名。
- 依赖 shell 命令或 agent 的文件落盘副作用。

这条规则需要静态候选 + AI 语义确认结合。

---

# P3：Dashboard 与报告升级

## P3-1 规则检查 Tab 增加来源与状态

表格升级为：

| Rule | 严重度 | 静态检查 | AI 检查 | 最终状态 | 证据数 |
|---|---|---|---|---|---|
| `REC-002` | high | 未执行/命中 | 命中 | AI / uncertain | 2 |

状态颜色：

- 绿色：pass
- 黄色：uncertain
- 紫色：AI hit
- 红色：conflict/error
- 蓝色：static hit

## P3-2 问题列表区分来源

每条问题显示：

```text
[STATIC] RETRY-001
[AI-RULE] REC-002
[BOTH] CONC-002
[CONFLICT] SERIAL-002
```

## P3-3 AI 分析 Tab 拆成两部分

当前“建议与 AI”混合了 Planner 建议。拆成：

1. **AI Rule Check**：逐规则检查结果、证据、引用、置信度。
2. **AI Planner 建议**：如何优化、如何验证、是否需要 Benchmark。

这样不会再把“AI 对已有 finding 的优化建议”误解成“AI 已完成全部规则检查”。

## P3-4 入口与聚合口径显示

概览 KPI 显示：

- 入口文件：1 finding
- 子 workflow：22 findings
- 聚合总数：23 findings
- AI Rule Check：已完成/部分完成/失败
- Planner：已完成/失败

---

# P4：真实场景验收与回归

## P4-1 静态报告验收

命令：

```text
/workflows anal thirdparties/PrdGameSkill/.opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js --no-open
```

验收：

- 12 个文件被发现。
- 入口/子流程/聚合三组统计清晰。
- Markdown 和 JSON 一致。
- 9 条旧规则均有结果。
- 新增跨文件规则有结果。

## P4-2 AI Rule Check 验收

默认不加关闭参数，AI 必须运行：

- 每条规则都有 AI 状态。
- AI hit 必须包含文件、行号、quote。
- 超时后静态结果仍可用。
- AI 结果不能覆盖静态确定事实。

## P4-3 真实问题回归清单

必须明确检查以下已知问题：

| ID | 已知问题 | 预期结果 |
|---|---|---|
| REC-002-001 | retry 影响集合未传入子流程 | hit |
| INPUT-002-001 | S5 仍校验客户端目录 | hit |
| BUDGET-001-001 | S4/S5 外层+内层并发预算未切分 | uncertain 或 hit |
| IO-001-001 | readBack 使用 agent 读取文件 | hit 或 uncertain |
| IO-001-002 | echoWrite 使用 agent 写文件 | hit 或 uncertain |
| CONC-002-001 | 动态 `partFiles.map` | hit / uncertain |
| SERIAL-002-001 | S4/S5 收尾并行候选 | uncertain |
| RETRY-001-001 | 全局 retries=2 | hit |

## P4-4 Dashboard 浏览器验收

- 概览 KPI 与聚合 JSON 一致。
- 规则检查表显示 9 条旧规则 + 新增规则。
- AI Rule Check 与 Planner 分栏。
- 问题列表显示静态/AI/Both/Conflict 来源。
- 点击规则能够过滤对应的静态和 AI finding。
- Windows 使用 `explorer` 打开，不弹 cmd 错误窗口。

---

## 四、建议执行顺序与交付物

| 阶段 | 内容 | 主要交付物 | 依赖 |
|---|---|---|---|
| P0 | 聚合模型与 Markdown 统一 | `AggregateAnalysisReport`、统一 MD/JSON | 无 |
| P1 | AI Rule Checker 基础链路 | rule loader、prompt、checker、evidence validator、merger | P0 |
| P2 | 跨文件规则 | REC-002、IO-001、BUDGET-001、INPUT-002、SIDEFX-001 | P0，部分依赖 P1 |
| P3 | Dashboard 分层展示 | Rule Check / AI Rule Check / Planner 三层 UI | P0/P1 |
| P4 | 真实场景验收 | 真实报告、Dashboard、回归测试、执行报告 | P0-P3 |

### 推荐最小可交付路径

不要一开始实现全部 14 条规则。建议：

1. 先完成 P0，修正 Markdown/Dashboard/JSON 口径。
2. 实现 P1 的 AI Rule Checker，但先只启用 5 条高价值语义规则：
   - `SERIAL-002`
   - `CONC-002`
   - `REC-001`
   - `INPUT-001`
   - `DET-001`
3. 新增 `REC-002` 和 `IO-001`，直接验证人工文档中的确定性问题。
4. 对真实入口跑通后，再加 `BUDGET-001`、`INPUT-002`、`SIDEFX-001`。
5. 最后重做 Dashboard 的 Rule Check / AI Rule Check 分层展示。

---

## 五、风险与控制

| 风险 | 控制措施 |
|---|---|
| AI 输出幻觉 | 强制行号、quote、证据校验；无证据丢弃 |
| AI 调用过慢 | 规则分组、并发上限 2、超时降级、保留静态报告 |
| AI 覆盖静态事实 | 静态与 AI 分层，冲突显示 conflict，不覆盖 |
| Prompt 过长导致模型无输出 | 相关文件裁剪、按规则组输入、禁止整项目无界拼接 |
| 报告数字再次不一致 | 单一 AggregateAnalysisReport，三种输出共用 |
| 把候选当缺陷 | confidence、uncertain、人工确认状态分离 |
| 过度抽象 | 第一版不做通用 workflow 工厂，只增加最小 loader/checker/merger |
| 真实项目误改 | AI 只输出建议，不直接写生产源码；所有修改走授权链 |

---

## 六、完成定义

本计划完成的标准不是“页面能打开”，而是以下闭环同时成立：

1. `/workflows anal` 默认执行静态检查和 AI Rule Check。
2. Markdown、JSON、Dashboard 三者数字一致。
3. 用户能清楚看到每条 rule：
   - 是否执行
   - 静态结论
   - AI 结论
   - 最终状态
   - 证据和代码位置
4. AI 能发现当前 Planner 无法发现的跨文件问题，至少包括 `REC-002` 和 `IO-001`。
5. 对不确定语义问题显示 `uncertain`，不伪装成确定缺陷。
6. AI 失败时静态报告仍完整生成，并明确显示失败原因。
7. 真实 `game-requirement-audit.js` 的 12 个文件全部参与分析，结果可在 Dashboard 中按文件和 rule 过滤。
8. 全量测试、真实脚本 smoke、浏览器验收均通过。
