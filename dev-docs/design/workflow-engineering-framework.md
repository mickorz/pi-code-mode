# Workflow Engineering Framework：完整架构设计

- 日期：2026-11-18
- 状态：**架构基线（长期有效）**——后续 M2/M3 等阶段的基础设施讨论以本文档为准，不重新讨论基础架构
- 配套执行计划：`dev-docs/planning/2026-11-18-workflow-engineering-m1-execution-plan.md`
- 已确定决策：

| 决策 | 选择 | 最终约束 |
| --- | --- | --- |
| Workflow Plan | A | 独立 Plan + Workflow JS |
| Analyzer | B | 检测 + 自动优化建议 + Agent 修改 |
| 兼容策略 | A | 旧 JS 完全兼容，渐进接入 |

---

## 一、项目总体定位

### 1.1 从 Workflow Runtime 升级为 Workflow Engineering Framework

本项目的发展方向定义为：

> **Workflow Engineering Framework：面向 Agent 的工作流设计、静态分析、执行优化与质量评估框架。**

这不是增加一个 Workflow Analyzer，而是建立一套从需求到执行、再到持续优化的工程体系。系统划分为五个层次：

```
Workflow Authoring   Skill：理解需求、设计流程、生成 JS、优化已有 Workflow
Workflow Plan        独立执行计划、资源预算、质量策略
Workflow JS          实际业务逻辑、控制流、数据处理
Workflow Analyzer    AST 分析、依赖分析、预算估算、风险检测、优化建议
Workflow Runtime     现有执行引擎、Agent 调度、并发控制、Journal、恢复
Workflow Evaluator   真实耗时、Token、成本、失败率、质量与优化反馈
```

五层职责：

| 层 | 解决的问题 |
| --- | --- |
| Authoring | 怎么正确创建 Workflow |
| Plan | 应该按照什么策略执行 |
| Analyzer | 当前设计有没有问题 |
| Runtime | 如何可靠地执行 |
| Evaluator | 实际执行效果如何，下一次如何改进 |

其中 Plan 和 JS 是两个独立产物，但必须保持一致。

### 1.2 三条架构原则

**原则一：业务逻辑和执行策略分离。**
Workflow JS 不应该因为修改模型、预算、并发策略就必须重写业务逻辑。

**原则二：确定性任务优先代码执行。**
统计、过滤、排序、编号、数据校验、精确去重，优先使用 JS。只有需要语义理解的工作才交给 LLM。

**原则三：优化必须有真实数据依据。**
Analyzer 可以提出优化建议，但不能把静态估算当成真实耗时。最终必须通过 Benchmark 验证。

---

## 二、Workflow Plan 详细设计

这是本框架最重要的设计之一。

### 2.1 Plan 和 Workflow JS 的关系

一对一关联，但允许多个 Plan 版本对应同一个 Workflow JS 版本。

```
.pi/workflows/
│
├── game-requirement-audit/
│   ├── 8-difference-review.js
│   ├── 10-unified-spec.js
│   │
│   └── plans/
│       ├── 8-difference-review.plan.json
│       └── 10-unified-spec.plan.json
│
└── plans/
    └── history/
```

对于没有独立子目录的旧 Workflow，Plan 放在统一的 plans 目录中，通过脚本路径关联。

**Plan 不直接写进 Workflow JS 的 meta。** 理由：

- Plan 需要独立版本管理
- 修改预算不应该改变业务脚本
- 不同运行模式可以复用同一份 JS
- Plan 可以独立审核
- Plan 可以通过历史数据不断更新

### 2.2 Workflow Plan Schema

第一版标准 JSON Schema 示例：

```json
{
  "schemaVersion": "1.0",
  "workflowId": "game_difference_review",
  "name": "游戏差异审查",

  "source": {
    "scriptPath": ".pi/workflows/game-requirement-audit/8-difference-review.js",
    "scriptHash": "sha256:...",
    "analyzedAt": "2026-11-18"
  },

  "execution": {
    "mode": "balanced",
    "concurrency": { "max": 4 },
    "modelPolicy": {
      "analysis": "fast",
      "writing": "default"
    }
  },

  "budget": {
    "maxAgents": 20,
    "maxDurationMs": 1800000,
    "maxInputTokens": 200000,
    "maxOutputTokens": 50000,
    "maxRetries": 5
  },

  "stages": [
    { "id": "scan", "name": "差异扫描", "type": "parallel", "dependsOn": [], "estimatedAgents": 8, "estimatedInputTokens": 50000 },
    { "id": "review", "name": "差异复核", "type": "parallel", "dependsOn": ["scan"], "estimatedAgents": 8 },
    { "id": "summary", "name": "汇总", "type": "sequential", "dependsOn": ["review"], "estimatedAgents": 1 }
  ],

  "quality": {
    "requiredValidation": true,
    "acceptanceCriteria": [
      "所有输入分片均有处理结果",
      "关键差异具有来源证据"
    ]
  }
}
```

三个关键设计：

**第一，sourceHash。**
Plan 必须记录对应的 JS 内容指纹。JS 修改后，Analyzer 能知道原 Plan 是否过期，不能继续把旧分析结果当作当前版本。

**第二，estimated 和 actual 分开。**
Plan 只记录预估值，真实运行数据归 Evaluator 管理。

**第三，execution mode。**
三个模式继承现有 `workflow-authoring` skill 的速度优先、质量优先设计：

| 模式 | 目标 | 策略 |
| --- | --- | --- |
| fast | 快速迭代 | 减少不必要的串行与验证 |
| balanced | 日常执行 | 速度与质量平衡 |
| quality | 正式交付 | 加强验证与冗余评审 |

### 2.3 Plan 的生命周期

1. **Created** — Authoring Skill 根据需求生成 Plan
2. **Analyzed** — Analyzer 检查 Plan 与 JS 是否一致
3. **Approved** — 用户确认执行策略和预算
4. **Executed** — Runtime 按 Plan 执行
5. **Evaluated** — Evaluator 对比预估和实际表现
6. **Optimized** — Agent 根据评估报告提出 Plan 或 JS 的优化修改

M1 只实现 Created、Analyzed，以及 Approved 前的检查能力。执行策略消费由后续阶段完成。

---

## 三、Workflow Analyzer 详细设计

### 3.1 设计原则

**不要让 LLM 负责分析代码本身的全部事实。**
代码结构由 AST 分析；LLM 负责理解业务意图、判断潜在设计问题、提出优化方案。

三层 Analyzer：

| 层 | 性质 | 职责 |
| --- | --- | --- |
| Static Analyzer | 确定性 | Acorn AST 分析、语法树遍历、调用关系、参数配置、代码位置、规则检测 |
| Semantic Analyzer | AI 辅助 | 判断任务是否可并行、是否需要 LLM、数据是否重复、是否存在更合理的阶段拆分 |
| Optimization Planner | 方案生成 | 根据风险生成优化建议，明确修改哪些代码、预期收益、质量风险和验证方法 |

三层的输出都必须能够追溯到原始代码。

### 3.2 Static Analyzer：八个分析器

| 分析器 | 检测内容 | 优先级 |
| --- | --- | --- |
| Call Graph | agent、parallel、pipeline、workflow 调用关系 | P0 |
| Dependency | 串行依赖与可并行候选 | P0 |
| Input | Prompt 构造、JSON.stringify、大输入传递 | P0 |
| Concurrency | 并发上限、任务数量、潜在多波次 | P0 |
| Timeout | 超时配置与默认超时 | P0 |
| Retry | 重试次数及潜在重复成本 | P0 |
| Deterministic | 可以用 JS 完成的操作 | P1 |
| Recovery | 阶段边界、子流程恢复能力 | P1 |

**容易误判的三个场景：**

**A. 串行检测**

```js
// 存在数据依赖的真串行
const a = await agent('扫描')
const b = await agent('复核：' + a)
const c = await agent('汇总：' + b)

// 语法串行但无数据依赖 —— Analyzer 应当提出并行候选，而不是直接改代码
const a = await agent('分析客户端')
const b = await agent('分析服务端')
const c = await agent('分析规则')
```

**B. 大输入检测**

```js
await parallel(
  groups.map(group => () =>
    agent(`分析以下内容：${JSON.stringify(allRequirements)}`)
  )
)
```
最危险的不是单次 Prompt 大，而是多个 Agent 重复传入同一份大型数据。应识别：公共输入、各 Agent 输入差异、重复传递字段、是否可在前置阶段过滤分片。**第一版静态分析不宣称能准确计算动态 Prompt Token。**

**C. 并发检测**

```js
setConcurrency(16)
await parallel(groups.map(group => () => agent('分析 ' + group)))
```
groups 有 48 组时输出：

```
任务数：48
并发上限：16
预计波次：3

风险：
第二、三波需要等待前一波释放资源。

建议：
评估分片合并策略，或减少不必要的任务数量。
```
同时需考虑任务耗时差异，不能直接认定墙钟时间一定是三倍。

### 3.3 Semantic Analyzer：AI 的职责边界

AI 不重新读取整个项目所有文件，只读取 Static Analyzer 输出的结构化报告与必要的局部代码片段：

```json
{
  "findings": [
    {
      "ruleId": "INPUT-001",
      "severity": "high",
      "location": { "file": "8-difference-review.js", "startLine": 80, "endLine": 105 },
      "description": "多个 Agent 重复接收相同需求全文",
      "evidence": ["allRequirements 被重复传递", "并行任务数量为 16"]
    }
  ]
}
```

AI 的工作：

1. 判断是否确实存在性能问题
2. 分析修改是否会影响业务正确性
3. 设计优化方案
4. 给出预期收益和风险
5. 提出需要补充的 Benchmark

最终输出是**结构化的优化建议**，不是泛泛的代码评审。

### 3.4 Optimization Planner：建议必须可执行

统一结构：

```json
{
  "id": "OPT-001",
  "title": "减少重复上下文",
  "severity": "high",
  "target": "8-difference-review.js",
  "problem": "多个 Agent 重复接收完整需求",
  "proposal": { "type": "input-reduction", "action": "增加确定性预处理和分片" },
  "expectedImpact": { "inputTokens": "预计减少", "duration": "待 Benchmark" },
  "qualityRisk": "medium",
  "validation": ["检查所有需求均被覆盖", "对比优化前后的结果一致性"]
}
```

**收益不能虚构数值**：没有历史 Benchmark 时写「待测」；有真实运行数据才允许量化收益。

---

## 四、M1 工程实现架构（复用现状）

仓库已存在可复用资产：

| 现有文件 | 复用点 |
| --- | --- |
| `src/engine/runtime/vm.ts` | Acorn 解析与脚本信封处理 |
| `src/engine/runtime/workflow-runtime.ts` | 运行时与调用记录 |
| `src/engine/types/index.ts` | 共享数据类型 |
| `src/engine/persistence/journal.ts` | 运行记录持久化 |
| `src/engine/agent/model-pool.ts` | 模型池 |
| `src/tools/workflow-tools.ts` | 工具入口 |
| `skills/workflow-authoring/` | 工作流创建 Skill |

M1 不需要再建一套独立的 JS Parser。推荐目录结构：

```
pi-code-mode/
│
├── skills/workflow-authoring/
│   ├── SKILL.md
│   ├── references/   （runtime.md / performance.md / workflow-plan.md / analyzer-rules.md）
│   ├── templates/
│   └── scripts/      （wf-syntax-check.cjs / wf-analyze.mjs）
│
├── src/
│   ├── engine/
│   │   ├── analyzer/
│   │   │   ├── types.ts  analyzer.ts  ast-parser.ts  call-graph.ts
│   │   │   ├── dependency-analyzer.ts  input-analyzer.ts
│   │   │   ├── concurrency-analyzer.ts  timeout-analyzer.ts  retry-analyzer.ts
│   │   │   ├── deterministic-analyzer.ts  rule-engine.ts  rules/  report-builder.ts
│   │   ├── plan/
│   │   │   ├── schema.ts  plan-loader.ts  plan-validator.ts  source-fingerprint.ts
│   │   └── runtime/    # M1 不改核心执行行为
│   └── tools/
│       └── workflow-analyze-tool.ts
│
├── tests/
│   ├── analyzer/   （fixtures/ + 各分析器 test + integration.test）
│   └── plan/       （schema.test / fingerprint.test / compatibility.test）
│
└── dev-docs/       （design/ planning/ benchmark/）
```

`workflow-tools.ts` 不需要重构，只在原有工具体系旁边增加独立的分析入口。

### 4.1 两种调用入口

**入口一：CLI**

```
pi-code-mode analyze .pi/workflows/example.js
```

输出：

```
Workflow Analyzer

[PASS] AST Parsing
[PASS] Workflow Syntax
[WARN] Serial Dependency
[WARN] Large Input
[HIGH] Repeated Context Injection

Agent Calls: 18
Concurrency: 16
Estimated Waves: 2

Risk Score: 72/100

Report:
.pi/workflows/reports/example.analysis.json
```

**入口二：Pi Agent 工具**

新增 `workflow_analyze`：

```
workflow_analyze({ scriptPath: ".pi/workflows/example.js", includeSuggestions: true })
```

返回结构化分析结果。后续 Authoring Skill 直接调用此工具，形成创建与优化闭环。

**两种入口共享同一套 Analyzer Core，不各自实现分析逻辑。**

### 4.2 Plan 与 Report 文件保存策略

```
.pi/workflows/
├── plans/
│   └── game_difference_review.plan.json
└── reports/
    ├── game_difference_review.analysis.json
    └── game_difference_review.analysis.md
```

- **Plan** 是可编辑、可版本管理的设计资产
- **Analysis Report** 是一次分析的结果，包含：sourceHash、analyzerVersion、ruleSetVersion、findings、executionEstimate、recommendations
- 旧 Workflow 没有 Plan 时，Analyzer 直接分析 JS 并输出建议创建 Plan，**不阻止运行**

---

## 五、架构陷阱（约束条款）

以下六条直接作为框架约束写入后续所有阶段的设计评审：

1. **不要让 Analyzer 变成第二个 Runtime。** Analyzer 只负责分析，不负责执行 Agent，不负责维护运行状态。
2. **不要把静态分析结果当作精确执行图。** JS 存在动态分支、动态任务数量、动态 Prompt，无法静态确定的地方必须标记 unknown。
3. **不要让 AI 直接重写所有 Workflow。** 优化建议必须经过用户或调用方授权；自动修改先在独立工作区进行，不能覆盖正在运行的脚本。
4. **不要为了 Plan 引入另一套完整 DSL。** Plan 是执行策略与工程元数据，JS 继续负责实际流程。
5. **不要为了性能牺牲需求覆盖率。** 拆分、截断、瘦身都必须保留完整证据覆盖能力。
6. **不要过早重构 Runtime。** 现有 `workflow-runtime.ts` 已有并发、重试、超时、Journal、子 Workflow 和执行观测能力，先利用这些能力建立分析基础。

---

## 六、最终路线图（Workflow Engineering Roadmap）

> 完整执行计划（M1-M5 任务分解与验收指标）：`dev-docs/planning/2026-11-18-workflow-engineering-m1-m5-execution-plan.md`

| 阶段 | 名称 | 解决的问题 |
| --- | --- | --- |
| M1 · Workflow Intelligence | **当前阶段**：Plan + Analyzer + Optimization Planner + Benchmark | 不知道 Workflow 为什么慢、如何改 |
| M2 · Execution Governance | RunBudget + TokenBudget + TimeBudget + 运行指标 | Workflow 运行失控、成本不可控 |
| M3 · Reliable Execution | BatchExecutor + TaskRegistry + TaskCheckpoint | 大规模任务失败后需要重复执行 |
| M4 · Adaptive Execution | AdaptiveScheduler + ModelPool 优化 + 输入管理 | 不同模型、不同任务的资源利用率 |
| M5 · Continuous Optimization | Evaluator + Benchmark + 历史性能基线 | 无法持续衡量和优化 Workflow |

M1 完成后，框架具备三项基础能力：

1. 能看懂 Workflow JS 的执行结构
2. 能判断设计中哪些地方存在性能风险
3. 能指导 Agent 有依据地修改，而不是靠经验猜测

预期效果示例（PrdGameSkill S10 场景）：

```
Workflow: 10-unified-spec

分析结果：
调用结构：
  Agent: 18
  串行阶段: 5
  并行阶段: 3
  最大并发: 16

发现问题：
  HIGH   输入上下文重复
  HIGH   大任务缺少有效分片
  HIGH   汇总阶段存在串行瓶颈
  MEDIUM 超时预算缺少任务级约束

优化方案：
  1. 提取公共输入
  2. 按业务边界分片
  3. 将独立任务改为并行
  4. 汇总阶段使用确定性合并
  5. 对关键产物增加验证

修改后：
  重新运行 Analyzer → 执行 Benchmark → 比较耗时/Token/失败率/输出质量
```

---

## 引用

- M1 执行计划：`dev-docs/planning/2026-11-18-workflow-engineering-m1-execution-plan.md`
- 现有资产：`src/engine/runtime/vm.ts`、`workflow-runtime.ts`、`src/engine/persistence/journal.ts`、`skills/workflow-authoring/`
- 外部测试样本来源：PrdGameSkill 仓库（`8-difference-review.js`、`10-unified-spec.js` 等）
