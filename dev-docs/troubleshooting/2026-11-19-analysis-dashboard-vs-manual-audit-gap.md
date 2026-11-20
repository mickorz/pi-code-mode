# Dashboard 与人工分析文档差异：为什么 `/workflows anal` 没分析出全部问题

- 日期：2026-11-19
- 对比对象：
  - Dashboard：`.pi/workflows/reports/dashboard/game-requirement-audit分析-Dashboard-20261119-01.html`
  - Dashboard 数据：同目录 `game-requirement-audit分析-Dashboard-20261119-01.json`
  - Markdown：`.pi/workflows/reports/game-requirement-audit.analysis.md`
  - 人工/AI 综合分析：`dev-docs/troubleshooting/2026-11-19-game-requirement-audit-workflow-analysis.md`
  - 被测入口：`thirdparties/PrdGameSkill/.opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js`

## 一、结论

`/workflows anal` 当前不是“对 9 条规则逐条让 AI 重新检查”，而是：

```text
程序静态扫描
  → 生成有限的 finding
  → 把这些 finding 的摘要交给 AI Planner
  → AI 只针对已有 finding 提优化建议
```

因此它**无法发现静态规则没有先命中的新问题**。

人工分析文档使用的是另一种流程：

```text
阅读主入口与 11 个子 workflow 的完整源码
  → 追踪参数、阶段、文件副作用、恢复链路和运行时语义
  → 发现静态规则未覆盖的架构问题
  → 用 AI/人工进行跨文件语义确认
```

所以两份结果的差异不是 Dashboard 丢了全部数据，而是**分析入口的能力边界不同**：

- Dashboard 展示的是 Analyzer 已产生的 finding 和 Planner 已生成的建议。
- 人工分析文档包含了“源码审阅发现的问题”，其中很多从未进入 Analyzer finding 集合。

---

## 二、逐项对比

### 2.1 Dashboard 实际分析出来的内容

Dashboard JSON 的最终数据：

| 维度 | 结果 |
| --- | --- |
| 文件 | 12 个 |
| 调用点 | 40 个 |
| finding | 23 条 |
| 规则命中 | `RETRY-001` ×12、`SERIAL-002` ×9、`CONC-002` ×2 |
| AI 建议 | 2~4 条，取决于模型输出 |
| 风险分 | 2/100 |

这 23 条 finding 都只来自 3 个静态规则：

1. `RETRY-001`：发现 `retries: 2`
2. `SERIAL-002`：发现源码相邻且无直接数据引用的 agent 调用
3. `CONC-002`：发现 `parallel(runtimeCollection.map(...))`

### 2.2 人工分析文档额外发现的内容

人工文档额外写出了：

1. `retry` 模式没有把 `impact-set.json` 的影响集合可靠传给子 workflow。
2. S5/server retry 仍可能被客户端目录校验阻断。
3. 入口与子 workflow 的 findings 统计口径容易误导。
4. S4/S5 外层并行与子流程内部并行的全局预算边界不明确。
5. `readBack()` 和 `echoWrite()` 把确定性 IO 交给 agent。
6. S4/S5、S7/S8 等同构流程的 timeout/retry/输出契约不统一。
7. S4/S5 的共享 runDir、manifest、锁和并行状态更新需要验证。
8. 动态分片的实际数量、波次、长尾和最大在途数没有运行时证据。

这些问题里，只有第 4、7、8 类部分会被 `CONC-002` 或 `SERIAL-002` 以“候选/提示”形式间接触及；其余问题根本没有对应的 Analyzer 规则或 finding。

---

## 三、根因一：AI Planner 不是 AI Rule Checker

当前调用链在 `src/tools/workflow-analyze-tool.ts`：

```ts
const prompt = buildPlannerPrompt(report)
const text = await input.plannerAgent(prompt)
const parsed = parsePlannerResponse(text)
recommendations = mergeRecommendations(report.recommendations, planner)
```

AI 的输入是已经生成好的 `report`，不是完整源码和 9 份规则文档。

`buildPlannerPrompt()` 还明确要求：

```text
仅基于下面的静态分析摘要提建议，不要重新分析项目
```

它收到的主要是：

- 风险分
- 调用点数量
- 已有 finding
- 已有 finding 的 evidence
- 少量 unknowns
- 输出格式要求

它**没有收到**：

- `game-requirement-audit.js` 完整源码
- 11 个子 workflow 完整源码
- `definitions/01~09-*.md` 规则全文
- `retry` 参数从入口到子 workflow 的完整数据流
- `fileExists()`、`stage-reuse`、`impact-set` 等运行时契约
- 所有文件写入路径与锁关系

所以 AI 不可能凭空发现：

```js
impactSet: stageResults.impactSet || null
```

是否丢失了 retry 分支里刚刚读取的 `impact.impactSet`。这不是模型“不聪明”，而是**输入中没有这条完整数据流**。

### 当前 AI 的正确定位

| 当前能力 | 是否支持 |
| --- | --- |
| 解释已有 `RETRY-001` finding | 支持 |
| 针对已有 `SERIAL-002` 提出语义确认建议 | 支持 |
| 针对已有 `CONC-002` 提醒确认分片数/并发/超时 | 支持 |
| 独立读取完整源码并逐条执行 9 条规则 | **不支持** |
| 发现静态规则未命中的 retry 数据流 bug | **不支持** |
| 发现跨文件输入校验、文件副作用、锁竞争问题 | **不支持** |

因此 Dashboard 中的 `[AI]` 表示“AI 对已有静态结果给了建议”，不是“AI 已经逐条检查所有 rule”。

---

## 四、根因二：9 个规则目前仍是程序规则，不是规则文档驱动的 AI 检查

虽然已经创建了：

```text
src/engine/analyzer/rules/definitions/
  01-INPUT-001-rule.md
  02-CONC-001-rule.md
  03-CONC-002-rule.md
  04-SERIAL-001-rule.md
  05-SERIAL-002-rule.md
  06-TIMEOUT-001-rule.md
  07-RETRY-001-rule.md
  08-DET-001-rule.md
  09-REC-001-rule.md
```

但这些 md 当前只用于：

- 人工阅读
- 规则与代码的一致性守卫测试
- 方案文档说明

它们**没有被读取并注入 AI 检查 prompt**。

`runRules()` 仍然是：

```ts
for (const rule of rules) {
  const produced = rule.analyze(context)
}
```

AI 没有按下面这种流程执行：

```text
for each rule document:
  read rule document
  read relevant source files
  independently judge pass/hit/not-applicable
  output evidence + line + confidence
```

这正是参考 `game-prd-check` 的关键差异。参考实现的阶段 2 会把每组规则文件和完整需求文档交给子代理，子代理直接按规则基准检查；当前 pi-code-mode 没有实现这一层。

---

## 五、根因三：静态规则的实现口径覆盖不到人工分析的问题类型

### 5.1 当前规则主要检查“局部语法形态”

| 规则 | 当前检查方式 | 无法覆盖的内容 |
| --- | --- | --- |
| `RETRY-001` | 正则找 `retries: N` | retry 是否应该传影响集合、错误类型是否可重试 |
| `SERIAL-002` | 调用点相邻 + 无直接标识符引用 | 文件副作用、共享状态、锁、隐式阶段依赖 |
| `CONC-002` | 找 `parallel(X.map(...))` | 实际 X 长度、真实波次、外层/内层全局预算 |
| `TIMEOUT-001` | 粗粒度统计 `timeoutMs:` | 某个调用是否继承正确 timeout、超时是否被真正消费 |
| `REC-001` | 任务数阈值 + `phase(` 计数 | phase 是否覆盖正确恢复边界、retry 是否真的只跑失败集合 |
| `INPUT-001` | 标识符重复注入启发式 | 跨函数/跨文件传递、实际运行时对象体积 |
| `DET-001` | prompt 关键词 | 真正的业务语义是否能确定性实现 |

人工文档中的主要问题属于：

- 跨函数数据流
- 跨文件参数传递
- 文件系统副作用
- 运行时并发预算
- 阶段恢复契约
- 多个 workflow 的同构配置一致性

这些不是当前 AST 局部规则能够可靠判断的。

### 5.2 `CONC-002` 只是提示，不是实际测量

例如 `10-unified-spec.js`：

```js
const stageResults = await parallel(
  structure.stages.map(...)
)
```

Analyzer 只能报告：

```text
集合 structure.stages 的长度静态不可知
并发上限未声明
单次超时 3600s
```

它不能知道：

- `structure.stages` 实际是 3 个还是 80 个
- 会产生几波
- S10 运行时是否还有其他并发任务
- 最长任务实际耗时

因此它没有报“实际多波次/长尾”，只报了“需要人工确认”。这不是漏报，而是当前规则的设计边界。

---

## 六、根因四：Markdown 报告本身仍有聚合口径缺陷

Dashboard 已经修过子流程 findings 合并，但 Markdown 仍然存在一个不一致：

### Dashboard JSON

```text
CONC-002: hit 2
SERIAL-002: hit 9
RETRY-001: hit 13
```

### 当前 Markdown

```text
CONC-002: 通过
SERIAL-002: 通过
RETRY-001: 命中 1
```

Markdown 的“检查清单”使用的是**入口自身 `report.ruleInventory`**，没有把 subtree 的规则命中合并进去；而 Dashboard 的 `buildDashboardView()` 后处理了子流程 hits。

所以同一次分析会出现：

- Dashboard 说规则命中 3 类、23 条 finding。
- Markdown 说只有 `RETRY-001` 命中 1 条。

这会进一步造成“`workflows anal` 没分析出来”的错觉，因为用户首先打开的是完整 Markdown 报告，而不是 Dashboard。

### 必须修复的统计一致性

Markdown、JSON、Dashboard 应共享同一个聚合报告模型：

```text
entry findings       = 入口自身结果
subtree findings     = 子流程结果
aggregate findings   = entry + subtree
aggregate ruleRuns   = 入口规则 + 子流程规则
aggregate severity   = aggregate findings 重算
```

不能让 Dashboard 自己在渲染阶段偷偷合并，而 Markdown 和 JSON 继续使用入口口径。

---

## 七、为什么人工文档能发现 retry 影响集合问题

人工分析文档真正做了“跨段阅读”：

1. 读取 `mode === 'retry'` 分支。
2. 看到 `impact` 从 `impact-set.json` 读出。
3. 继续追到 `runStage()`。
4. 对比 `runStage()` 中传给子 workflow 的 `impactSet` 来源。
5. 发现它读的是 `stageResults.impactSet`，而不是刚读取的 `impact.impactSet`。
6. 推断 retry 可能退化成普通端级重跑。

当前 Analyzer 没有这种能力，因为：

- `RETRY-001` 只检查 `retries` 数字。
- 没有“retry 数据流完整性”规则。
- AI Planner 没有完整源码。
- AI 被明确要求“不要重新分析整个项目”。

要发现这个问题，至少需要新增一个跨文件/跨控制流规则，或者让 AI 读取相关完整源码并按规则文档独立复核。

---

## 八、需要怎样改，才能符合“默认用 AI check rule”的目标

### 8.1 正确的新流程

```text
阶段 A：程序静态扫描
  - 快速构建 AST、调用图、局部 finding
  - 识别文件、函数、调用点和候选相关代码范围

阶段 B：AI Rule Checker（默认开启）
  - 读取 9 份 rule.md
  - 读取入口 + 全部子 workflow 源码
  - 按 rule 逐条检查
  - 输出 pass / hit / not-applicable / uncertain
  - 每个 hit 必须给文件、行号、原文证据、原因、置信度

阶段 C：证据校验
  - 行号必须落在实际源码范围
  - 引文必须能在源码中找到
  - ruleId 必须存在于规则目录
  - 无证据的 AI finding 丢弃

阶段 D：合并
  - 静态结构事实保留
  - AI 语义 finding 追加
  - 静态与 AI 冲突时两者都保留并标记冲突
  - 重新计算 aggregate rule inventory / severity / risk

阶段 E：输出
  - Markdown 与 Dashboard 使用同一份最终聚合 JSON
  - 明确区分 static / ai / conflict / uncertain
```

### 8.2 9 条规则的 AI 检查输入

不能只传当前 1159 字符的 Planner 摘要。应为每条规则构造检查上下文：

```json
{
  "ruleId": "REC-001",
  "ruleDocument": "definitions/09-REC-001-rule.md 的全文",
  "sourceFiles": [
    "game-requirement-audit.js",
    "4-client-verify.js",
    "5-server-verify.js"
  ],
  "staticHints": [
    "当前静态规则结果",
    "调用图",
    "unknowns"
  ]
}
```

不能继续复用当前 Planner prompt，因为 Planner 的目标是“根据 finding 提建议”，不是“执行 rule”。

### 8.3 应新增的 rule 文档/AI 输出字段

| 字段 | 用途 |
| --- | --- |
| `status` | `hit` / `pass` / `uncertain` / `not-applicable` |
| `source` | `static` / `ai` / `both` |
| `file` | 证据所属文件 |
| `startLine` / `endLine` | 可核对位置 |
| `quote` | 原文引文 |
| `reason` | 按规则文档解释为什么命中 |
| `confidence` | 语义置信度 |
| `verification` | 人工或 Benchmark 验证条件 |

当前 `RuleRun` 只有：

```ts
{ id, severity, description, hits, error? }
```

这不足以表达 AI 逐条复核结果。

---

## 九、当前结果应该怎样正确解读

现在这份 Dashboard 并不是完全错误，而是应该这样读：

1. **规则检查 Tab**：表示 9 条程序静态规则已经执行。
2. **23 条问题**：表示静态规则在 12 个文件中发现的 23 条问题。
3. **AI 建议 Tab**：表示 AI 对这些静态问题进行了优化建议，不是 AI 对所有源码重新审计。
4. **人工分析文档**：包含跨文件数据流、文件副作用、恢复契约和运行时预算等额外审阅结果。
5. 人工文档里的 P1-001、P1-003、P2-001 等问题目前不能从 Dashboard 的“规则命中数”中推断出来。

因此真正的问题不是“Dashboard 把 finding 隐藏了”，而是：

> 当前 `anal` 的 AI 层是 Planner，不是 Rule Checker；当前静态层是局部 AST 规则，不是跨文件语义审计器。

---

## 十、修复优先级

### P0：先修报告一致性

1. 把 subtree findings/rule hits/severity counts 统一合并到最终 `AnalysisReport`。
2. Markdown、JSON、Dashboard 全部消费同一份 aggregate 数据。
3. 在报告中明确 `entry findings` 与 `aggregate findings`，避免口径混淆。

### P1：实现真正的 AI Rule Checker

1. 读取 `definitions/` 下 9 份规则文档。
2. 为每条 rule 提供相关源码文件，而不是只提供静态摘要。
3. AI 输出结构化 `ruleChecks`，带 status、证据、行号、置信度。
4. 加证据校验与失败降级。
5. Dashboard 增加“静态判断 / AI 判断 / 冲突”列。

### P2：补足跨文件静态规则

至少新增：

- `REC-002`：retry 影响集合传递完整性
- `IO-001`：确定性 IO 是否被 agent 代理
- `BUDGET-001`：嵌套 workflow 并发预算是否显式分配
- `INPUT-002`：阶段输入校验是否超出目标阶段需要
- `SIDEFX-001`：候选并行调用是否共享文件/状态副作用

这些规则不能只靠当前 `runRules()` 的单文件局部 AST，需要跨文件调用图、字符串路径和数据流摘要。

---

## 十一、验收标准

修复后对同一个入口重新执行 `/workflows anal`，必须同时满足：

1. Markdown 和 Dashboard 的总 finding 数一致。
2. Markdown 和 Dashboard 的规则命中数一致。
3. 入口自身 1 条、子流程 22 条、聚合 23 条的口径明确可见。
4. AI Rule Checker 能发现或明确判断以下问题：
   - retry 影响集合传递
   - 动态分片实际规模未知
   - S4/S5 外层与内层并发预算
   - readBack/echoWrite 的确定性 IO 代理风险
   - 阶段输入校验范围
5. 每条 AI finding 都有 ruleId、文件、行号、引文和置信度。
6. 无证据的 AI 结论不进入最终 finding。
7. AI 超时后仍生成完整静态报告，并明确标注 AI 检查未完成。

---

## 引用

- Dashboard：`.pi/workflows/reports/dashboard/game-requirement-audit分析-Dashboard-20261119-01.html`
- Dashboard 数据：`.pi/workflows/reports/dashboard/game-requirement-audit分析-Dashboard-20261119-01.json`
- 当前 Markdown：`.pi/workflows/reports/game-requirement-audit.analysis.md`
- 人工分析：`dev-docs/troubleshooting/2026-11-19-game-requirement-audit-workflow-analysis.md`
- Analyzer 入口：`src/tools/workflow-analyze-tool.ts`
- AI Planner：`src/engine/analyzer/optimization-planner.ts`
- 规则引擎：`src/engine/analyzer/rule-engine.ts`
- 跨文件分析：`src/engine/analyzer/tree-analyzer.ts`
- 参考 AI 规则检查流程：`thirdparties/PrdGameSkill/.claude/skills/game-prd-check/SKILL.md` 阶段 2、阶段 7
