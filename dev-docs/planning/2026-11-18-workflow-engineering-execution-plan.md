# Workflow Engineering Framework：执行计划（M1-M5）

- 日期：2026-11-18
- 架构基线：`dev-docs/design/workflow-engineering-framework.md`（五层框架、三条原则、六条陷阱约束——本文档全部任务受其约束）
- 执行顺序：**M1 → M2 → M3 → M4 → M5 串行**，每阶段依赖前置交付物；PrdGameSkill 为贯穿全部阶段的真实测试项目
- 依赖修正（2026-11-18 评审 P0-1）
- 修订记录：2026-11-18 评审修订（M4/M5 依赖、M3 分层指纹与副作用四状态、M2 预算三分类、M1 置信度分级与规则接口、Plan 身份与 Profile、T7 授权边界、M5 指标替换）已全部落实并经二轮评审确认
- 修订记录：2026-11-18 M1 完成 —— T0-T8 全部交付（Plan/AST/规则引擎/Report/AI Planner/CLI+工具/Skill/Benchmark），67 断言全 PASS，详见 `dev-docs/progress-result/MCP-M1-执行报告.md`
- 修订记录：2026-11-18 五轮评审修订——P0-1 M1 接口承诺对齐 Definition/Profile Schema 并新增 WorkflowRunConfig 概念（与 WorkflowPlan 分离，M2 Plan Runner 组合）；P0-2 TaskCheckpoint 增加 leaseGeneration（Fencing Token），提交原子 CAS 校验双字段；P1-1 Budget Reservation 原子预留/释放/结算五条约束；P1-2 动态降级 Run 级语义（activeProfile/effectivePolicy/policyTransitions，降级只影响未调度任务）；P1-3 三 Profile 完整示例（默认 balanced）与 Validator 解析规则；新增 Execution Trace 跨阶段能力与五级关联 ID
- 修订记录：2026-11-18 三轮评审修订——P0：taskFingerprint 补 executionContractVersion/modelConfigHash 细化/externalDepsHash，TaskCheckpoint 增加 lease 并发安全与原子提交（四规则），外部副作用幂等键；P0：M4 上下文三层（Shared/Task/Evidence Reference），质量验收扩展证据覆盖率；P1：M1-T1 Plan Definition/Profile Schema 落地 + hash 命名统一，M1-T2 动态循环/动态分发处理边界，M1 指标限定为静态可确定节点；修正 M4 范围/M3 指标/M5 汇总表三处文档不一致；新增跨阶段能力 Execution Trace：**M4 自适应调度消费 M2/M3 已有的运行观测数据（轻量耗时画像），不依赖 M5 的正式性能基线**——M5 在 M4 之后完善长期数据，消除依赖倒置
- 数据能力分层（评审 P0-1 修正依据）：当前 Run 实时数据→M2；多 Run 基础记录→M2/M3；简单历史统计→M4 消费；正式基线/趋势/回归检测→M5。原则：下游阶段不得依赖上游尚未建立的数据能力

---

## 总览

| 阶段 | 名称 | 核心交付 | 解决的问题 | 状态 |
| --- | --- | --- | --- | --- |
| M1 | Workflow Intelligence | Plan Schema + Analyzer + Optimization Planner + Benchmark | 不知道 Workflow 为什么慢、如何改 | **已完成**（2026-11-18，67 断言全 PASS，recall 100%/FPR 0%） |
| M2 | Execution Governance | Budget 体系 + Plan 执行消费 + 运行指标 | 运行失控、成本不可控 | 未开始 |
| M3 | Reliable Execution | TaskRegistry + BatchExecutor + TaskCheckpoint | 大规模任务失败后重复执行 | 未开始 |
| M4 | Adaptive Execution | 输入分片/公共上下文执行 + AdaptiveScheduler + ModelPool 自适应 | 资源利用率与 token 浪费 | 未开始 |
| M5 | Continuous Optimization | Evaluator + 性能基线 + 优化闭环 | 无法持续衡量与优化 | 未开始 |

**全局约束**（适用于所有阶段，源自架构基线第五节）：

1. Analyzer 不变成第二个 Runtime；静态分析结果不当作精确执行图（unknown 必须标注）
2. AI 不直接重写生产 Workflow——修改先在独立工作区，经授权后应用
3. 不为 Plan 引入第二套 DSL；不为性能牺牲需求覆盖率
4. **Runtime 核心执行语义保持兼容**：M2+ 需要的挂钩点（预算闸、任务登记、调度回调）以可选 options 注入，旧脚本零改动可跑
5. 每阶段结束：更新本文档状态表与架构基线；PrdGameSkill 跑一轮真实对照

---

## M1 · Workflow Intelligence（工作流理解与性能分析）

## 一、M1 范围

### 纳入

1. Workflow Plan Schema
2. AST 静态分析
3. Workflow 调用关系图
4. 依赖与并行候选分析
5. 输入规模与重复输入检测
6. 并发、超时、重试风险分析
7. Analyzer 规则引擎
8. 结构化分析报告
9. AI 优化建议
10. workflow-authoring Skill 集成
11. CLI 和 Pi 工具入口
12. Benchmark 测试

### 暂不纳入（后续 M2～M5）

- Runtime 动态并发调整
- 自动分片执行
- 任务级 Checkpoint
- Token 预算强制执行
- 自动修改生产 Workflow 并直接运行
- 自动学习历史执行数据

---

## 二、开发任务（T0 ~ T8，全部 P0）

### T0：基线与测试样本（真实性能基线，M1 最重要的交付）

**工作内容**

- 检查当前 Analyzer 相关基础设施
- 确认 Acorn AST 能力与现有 VM 解析逻辑的复用边界
- **真实样本收集**：PrdGameSkill 的 S8（8-difference-review）、S10（10-unified-spec）、game-prd-check 等真实 Workflow
- **执行数据还原**：从现有 Journal 与执行报告提取 per-Agent 耗时、Token、失败、重试、并发情况
- **原子测试集**：串行依赖 / 动态循环 / 重复上下文 / 并行波次 / 子 Workflow 五类测试样本
- **优化效果基线**：固定输入规模、模型配置、质量标准，保存优化前数据——**必须记录质量指标**（需求覆盖率/证据映射），否则后续无法证明优化未损害质量

**交付物**：`dev-docs/design/m1-baseline.md`、`tests/analyzer/fixtures/`、`dev-docs/benchmark/m1-baseline.json`、真实 Workflow 性能基线报告

**验收**：能够使用真实 Workflow 重现至少三种性能风险；基线含质量指标（否则 token 降低 50% 也无法证明 PRD 需求覆盖率未受损）。

### T1：Workflow Plan

**工作内容**

- 定义 Plan JSON Schema（**Definition 与 Profile 分离落地，评审 P1-2**）
- 定义指纹字段（统一命名）：`source.scriptHash`（JS 内容指纹）/ `planHash`（Plan 内容指纹）/ `planVersion`（Plan 版本）/ `analyzedAt`（分析时间，属报告元数据）
- **planHash 计算规则（评审 P0-4，防自引用）**：`planHash = SHA256(canonicalJSON(Plan without planHash))`——剔除 planHash 字段后对剩余内容做 canonical JSON 再哈希。参与：planVersion / source.scriptHash / definition / profiles；**不参与：source.analyzedAt / planHash**
- **activeProfile**：run 级字段，记录当前 Run 选择的 Profile 名（同一 Plan 可在不同 Run 使用不同 Profile）；`profileHash`（当前 Profile 独立指纹）随 run 记录，用于精确追踪运行配置
- **planHash 计算规则（评审 P0-4，防自引用）**：`planHash = SHA256(canonicalJSON(Plan without planHash))`——剔除 planHash 字段后对剩余内容做 canonical JSON 再哈希：

  | 字段 | 参与 planHash 计算 |
  | --- | --- |
  | planVersion | 是 |
  | source.scriptHash | 是 |
  | source.analyzedAt | **否** |
  | definition | 是 |
  | profiles | 是 |
  | planHash | **否**（自引用排除） |

  相同 Plan 内容 → 稳定 Hash
- **activeProfile**：run 级字段，记录当前 Run 选择的 Profile 名（同一 Plan 可在不同 Run 使用不同 Profile）；`profileHash`（当前 Profile 独立指纹）随 run 记录，用于精确追踪运行配置
- 实现 Plan Loader / Plan Validator
- 实现 Plan 与 Workflow JS 的关联
- 支持旧 Workflow 没有 Plan 的情况

**Schema 结构（`workflow.plan.json`）**：**以架构基线 2.2 节的 Definition/Profile Schema 为唯一事实源**（`definition`（stages/quality 强制项）+ `profiles`（fast/balanced/quality 差异化执行策略，嵌套 execution/modelPolicy/budget）），本节不再单独定义字段结构，避免两文档漂移。

- fast/balanced/quality 是同一 Definition 的 Profile，**只覆盖执行策略，不复制 stages**
- **Profile 不能降低安全预算约束，也不能自动关闭强制性的质量验证**（`requiredValidation: true` 为 Definition 级强制项）

**交付物**：`src/engine/plan/`、`tests/plan/`

**验收**：合法 Plan 可读取；非法 Plan 可定位错误；JS 修改后能发现 Plan 过期；Profile 切换不影响 Definition；没有 Plan 的旧 Workflow 正常工作。

> **开发顺序说明（评审建议五）**：不等 T4 全部完成才验证 Analyzer 有效性——**T2/T3 即用 PrdGameSkill 的 S8、S10 做阶段性验证**，尽早暴露"AST 分析能力不足以支持真实 Workflow（大量动态代码无法识别）"的风险。

### T2：AST Analyzer

**工作内容**

- 复用 Acorn
- 识别 agent / parallel / pipeline / sequence / fallback / race 调用
- 识别 workflow 子流程调用
- 提取调用参数和代码位置
- 建立 Call Graph 与依赖关系
- **动态代码处理边界（评审 P1-1，必做）**：

   | 代码形态 | 输出 |
   | --- | --- |
   | 静态可确定（字面量调用） | 输出精确节点 |
   | 动态循环（`for (const t of tasks) await agent(t.prompt)`） | 输出动态节点及上下界；上下界无法确定则不估算 |
   | 动态分发（`handlers[type](input)`） | 标记 Unknown |
   | 运行时补充 | 后续由 M2 的执行观测补充实际调用数量 |

   不为满足"识别率 100%"伪造无法静态推断的数据
- **动态代码处理边界（评审 P1-1，必做）**：

   | 代码形态 | 输出 |
   | --- | --- |
   | 静态可确定（字面量调用） | 输出精确节点 |
   | 动态循环（`for (const t of tasks) await agent(t.prompt)`） | 输出动态节点及上下界；上下界无法确定则不估算 |
   | 动态分发（`handlers[type](input)`） | 标记 Unknown |
   | 运行时补充 | 后续由 M2 的执行观测补充实际调用数量 |

   不为满足"识别率 100%"伪造无法静态推断的数据

**交付物**：`src/engine/analyzer/ast-parser.ts`、`call-graph.ts`、`dependency-analyzer.ts`

**依赖置信度分级（评审补充-1，必做）**——静态分析不能断定业务独立性，每条依赖边必须标注：

| 置信度 | 含义 |
| --- | --- |
| Explicit | 明确的数据依赖（后调用引用了前调用的结果） |
| Structural | 由代码控制流产生的依赖（同一 sequence/条件分支内） |
| Candidate | 可能独立，需要语义判断（并行候选，交 Semantic Analyzer 确认） |
| Unknown | 无法静态确定（动态表达式/间接引用） |

**验收**：准确统计已知 DSL 调用；依赖边全部携带置信度标注；Candidate 与 Unknown 不允许被自动并行化建议直接采纳；输出有来源位置的调用图。

### T3：性能规则引擎

**工作内容**

- 输入规模检测 / 重复上下文检测 / 并发波次估算 / 超时风险 / 重试风险 / 确定性操作识别 / 恢复能力检测
- 规则严重程度和置信度

**交付物**：`src/engine/analyzer/rules/`、`rule-engine.ts`

**规则注册机制（评审补充-2，必做）**——统一规则接口，支持持续扩展与第三方贡献：

```ts
interface AnalyzerRule {
  id: string
  version: string
  severity: "critical" | "high" | "medium" | "low"
  analyze(context: AnalyzerContext): AnalyzerFinding[]
}

interface AnalyzerFinding {
  ruleId: string
  severity: string
  confidence: number          // 0-1，静态结论的置信度
  location: { file: string; startLine: number; endLine: number }
  evidence: string[]
  suggestion?: string
}
```

**验收**：每条风险有 ruleId、能定位代码、带 confidence；不确定的结果明确标注；新增规则不需要修改 Analyzer 主体；有测试证明不会把合法串行流程误判为确定的性能缺陷。

### T4：Analyzer Report

**工作内容**

- 汇总静态分析结果、生成调用图、计算静态风险等级
- 估算调用数量、并发波次和上下文规模
- 输出优化建议数据结构
- 支持 JSON 和 Markdown

**交付物**：`src/engine/analyzer/report-builder.ts`、报告 Schema、报告测试样本

**验收**：同一脚本、相同 Analyzer 版本与规则集，生成**确定性**分析结果。

### T5：AI Optimization Planner

**工作内容**

- 根据静态报告构造精简 Prompt
- 分析业务依赖、判断优化是否影响业务语义
- 输出优化操作建议 + 修改位置 + 预期收益 + 质量风险 + 验证标准

**交付物**：优化建议 Schema、AI 分析 Prompt、优化建议测试样本

**验收**：AI 不能只说「建议并行化」，必须说明依赖关系、修改方式和验证条件。

### T6：CLI + Pi 工具集成

**工作内容**

- CLI analyze 命令
- `workflow_analyze` 工具（支持 scriptPath / 内联脚本 / JSON / Markdown 输出）
- 与现有 workflow 工具保持独立

**交付物**：CLI 命令、`src/tools/workflow-analyze-tool.ts`

**验收**：CLI 与 Pi 工具使用相同 Analyzer Core，输出一致。

### T7：Workflow Authoring Skill 集成

**工作内容**

- 修改 Skill 的创建流程
- 新增 Plan 生成步骤、Analyzer 检查步骤、优化建议处理流程
- 增加修改后重新分析的循环与交付检查

**授权边界（评审补充-4，必做）**——T7 的"根据报告修正问题"不是自动改生产脚本，固定为六步链：

```
Analyzer 分析 → 生成 Optimization Suggestions → Agent 在独立工作区修改
→ 重新 Analyzer + Benchmark → 用户确认 → 应用修改
```

PrdGameSkill 等生产 Workflow：需求覆盖、证据映射与质量验证必须在修改后保留（陷阱 5），不能因 Analyzer 认为可合并任务就直接改生产脚本。

**交付物**：`skills/workflow-authoring/SKILL.md` 更新（+ references/workflow-plan.md、analyzer-rules.md）

**验收**：Agent 创建或修改 Workflow 时，自动执行静态分析并根据报告修正问题；修改动作全部发生在独立工作区并经用户确认后才应用。

### T8：Benchmark

**工作内容**

- 建立标准测试集
- 测试 Analyzer 检测准确率、误报率、漏报率、Plan 过期检测、旧 Workflow 兼容性
- 对优化后的 Workflow 进行实际运行对比

**交付物**：`dev-docs/benchmark/` 测试集与 M1 验收报告

**验收**：完成 M1 验收报告，证明分析结果具有实际优化价值。

---

## 三、Benchmark 设计

**不要只用人为编写的简单 Workflow 测试。** PrdGameSkill 是真实测试项目，建立三个测试组：

| 测试组 | 样本 | 验证目标 |
| --- | --- | --- |
| A：原子测试 | 人工编写的短 Workflow | AST 检测正确性 |
| B：真实 Workflow | PrdGameSkill 的 S8、S10 等 | 实际风险发现能力 |
| C：优化对照 | 优化前后两个版本 | 实际耗时、Token、质量变化 |

### 重点测试的真实场景

| 测试样本 | 重点检测 |
| --- | --- |
| 8-difference-review.js | 大规模差异分析、输入重复、串行尾部 |
| 10-unified-spec.js | 长时间运行、任务拆分、失败恢复风险 |
| game-prd-check.js | 多任务并行、重复上下文 |
| output-spec-generate | 子 Workflow、阶段依赖 |
| 简单短 Workflow | 误报率和额外复杂度 |

**需要从真实执行报告中提取每个 Agent 的耗时、Token、失败和重试数据——不能仅凭 Workflow JS 推断任务慢在哪里。**

---

## 四、M1 量化验收指标

| 指标 | 目标 |
| --- | --- |
| 静态可确定节点的 DSL 识别率 | 100%（动态循环/动态分发按边界规则标注，不伪造） |
| 直接依赖关系识别 | 测试样本 100% |
| 已知风险规则测试通过率 | 100% |
| 关键风险代码定位准确率 | ≥95% |
| 静态分析误报率 | ≤10% |
| 旧 Workflow 兼容测试 | 100% |
| Analyzer 输出确定性 | 100% |

注意：误报率基于**人工标注的风险样本**计算，不能用所有检测项数量简单计算。

---

## 五、M1 最终交付物（五项）

1. **Workflow Plan** — 标准化的工作流设计与执行策略文件
2. **Workflow Analyzer** — 可分析任意符合当前 DSL 契约的 Workflow JS
3. **Analysis Report** — 调用图、性能风险、估算数据和改进建议
4. **Optimization Planner** — Agent 能理解报告并提出有验证条件的代码修改
5. **Benchmark Suite** — 能通过真实 Workflow 验证 Analyzer 是否有效

---

**对后续阶段的接口承诺（M2-M5 依赖这些产物，五轮评审 P0-1 对齐架构基线 2.2 Definition/Profile Schema）**：
- `WorkflowPlan`（描述工作流定义与可选执行策略）：`{ planVersion, planHash, workflowId, source, definition, profiles }`
- `WorkflowRunConfig`（描述本次实际执行选择了什么策略）：`{ workflowId, runId, planHash, activeProfile, profileHash }`——与 WorkflowPlan 是**两个不同概念**，M2 的 Plan Runner 负责把两者组合成最终执行配置
- `AnalysisReport`（JSON，findings 带 ruleId/severity/location/evidence）
- `OptimizationSuggestion`（Schema，含 expectedImpact/qualityRisk/validation）

---

## M2 · Execution Governance（执行治理）

**目标**：让 Plan 真正被 Runtime 消费——预算可控、超限有策略、运行指标完整。解决「workflow 运行失控、成本不可控」。

### 范围

**纳入**

1. Budget 强制执行：`Plan.budget` 在 Runtime 侧生效。**预算分三类，执行策略不同（评审 P0-3）**：

   | 类型 | 字段 | 执行策略 |
   | --- | --- | --- |
   | 硬预算 | maxAgents / maxDurationMs / maxRetries | dispatch 前拦截，超限即停 |
   | 软预算 | maxInputTokens / maxOutputTokens | 调用前**预估预留** → 执行后**按真实 usage 结算**；超软限触发停止或降级（quality→fast） |
   | 实际计量 | 模型返回 usage | 结算依据；无法精确计量的模型标记为估算值 |

   - `maxOutputTokens` 区分两个概念：**单次模型输出上限**（model 参数级）与 **workflow 累计输出预算**（run 级），不混用
   - `maxAgents` 明确定义为 **agent 总 dispatch 次数**（与现有 runtime agentCount 同口径）
2. Plan 生命周期 **Executed** 阶段：`runWorkflow` 接受 `planPath`，按 Plan 注入执行策略（mode/concurrency/modelPolicy/budget）
3. 运行指标聚合：per-agent usage（已有）→ run 级聚合（input/output tokens、耗时、重试次数、失败清单）
4. 超限策略：预算耗尽的行为分级（agent 级可恢复失败 / run 级终止并报告剩余任务）
5. 预算余量查询：脚本内 `budget.remaining()`（供脚本自行降级，如 quality 档降 fast 档）
6. CLI/工具：`workflow run --plan <path>`、`workflow plan validate`

**暂不纳入**（M4/M5）

- 预算的自适应调整、跨 run 全局预算池、成本货币化计费

### 任务分解

| 任务 | 内容 | 交付物 | 验收 |
| --- | --- | --- | --- |
| M2-T1 Budget Schema 扩展 | Plan Schema 的 budget 字段类型化进 `src/engine/plan/`；与 agent 默认 timeoutMs/retries 联动规则 | plan schema v1.1 | 合法/非法 budget 均可定位 |
| M2-T2 Token/耗时计量聚合 | per-agent usage 聚合为 run 级计数器（复用 M2 前已采集的 usage）；提供余量查询 | `src/engine/governance/budget-tracker.ts` | 聚合值与 journal 逐条求和一致 |
| M2-T3 预算强制执行 | 硬预算 dispatch 前拦截；软预算**预估预留 → usage 结算**（含估算值标记）；超软限停止/降级 | `budget-gate.ts` 注入 runtime（可选 options，旧脚本零改动） | 硬预算超限 100% 拦截；软预算结算与 usage 一致；旧 workflow 兼容 |
| M2-T4 Plan 执行消费 | `runWorkflow({ planPath })`：读 Plan → 注入 mode/concurrency/modelPolicy/budget | plan-runner 集成 | 同一 JS + 不同 Plan 产生不同执行策略 |
| M2-T5 budget.remaining() 脚本 API | VM 注入余量查询（供脚本自主降级） | globals 注入 | 脚本内可读余量并分支 |
| M2-T6 工具与 CLI | `workflow run --plan`、`workflow plan validate` 命令 | 工具扩展 | CLI 与工具同一 Plan Core |
| M2-T7 Benchmark | 预算强制用例（超硬预算/软预算降级/超 agent 数）；软预算**预估精度**用例；Plan 注入兼容回归 | `dev-docs/benchmark/m2-*.json` | 量化验收达成 |

### 验收指标

| 指标 | 目标 |
| --- | --- |
| 预算超限拦截率 | 100%（三类预算各 ≥3 用例） |
| Plan 注入对旧 workflow 兼容性 | 100%（无 Plan 路径行为逐字节不变） |
| 运行指标完整性 | run 级聚合 = journal 逐条之和 100% |
| budget.remaining() 精度 | 与 budget-tracker 一致 |

**依赖**：M1 的 Plan Schema 与 Loader（T1 产物）。

---

## M3 · Reliable Execution（可靠执行）

**目标**：大规模任务（数十到数百 agent）失败后**只重跑失败部分**，已成功任务不重复消耗 token。解决「48 组任务跑到第 40 组挂了要全部重来」。

### 范围

**纳入**

1. **TaskRegistry**：任务清单持久化——静态可枚举任务（Plan stages/分片清单）+ 运行时动态登记任务（并行 batches 运行时注册）
2. **BatchExecutor**：清单驱动的批量执行器——按清单调度、状态流转（pending/running/done/failed）
3. **TaskCheckpoint**：任务级检查点持久化——跨 run 恢复的依据。**恢复判定用分层指纹（评审 P0-2，本轮补充执行契约与外部依赖维度）**：整体 `scriptHash` 粒度过粗（改一行日志 → 全部任务产物失效，违背 M3 初衷），改为

   ```
   workflowId
     └── taskKey
          ├── taskDefinitionHash        # 任务定义（prompt 模板/调用形态）
          ├── inputHash                 # 输入数据指纹
          ├── promptHash                # 最终 prompt 指纹
          ├── modelConfigHash           # 模型 ID + 关键参数及一切影响输出的配置（不能只比模型名称）
          ├── executionContractVersion  # 输出契约版本（输出结构变化时旧产物不能被新下游安全消费）
          └── externalDepsHash          # 外部依赖指纹（知识库/MCP server/代码库快照变化 → 缓存失效）
   ```

   - **taskFingerprint** = hash({ taskKey, taskDefinitionHash, inputHash, promptHash, modelConfigHash, executionContractVersion, externalDepsHash }) → 判断单个任务产物是否可复用；修改无关任务不影响其他任务的产物复用
   - `externalDepsHash` **按任务实际依赖逐项计算**（客户端任务只含客户端代码快照指纹；规则检查任务只含规则文档指纹）——客户端代码变化不应失效无关的规则检查任务
   - `modelConfigHash` 含模型 ID + 关键参数及一切影响输出的配置，不能只比较模型名称
   - **workflowVersionHash**（整体 scriptHash）仅用于审计与 Plan 过期检测，不参与产物复用判定
   - **外部副作用四状态**（缺一不可）：任务执行状态 / 产物持久化状态 / 外部副作用提交状态 / 重试幂等性（副作用类任务须有独立幂等键）——任务"执行完成"不等于"副作用已提交"，避免崩溃后重复发布

   **Checkpoint 记录结构与提交规则（评审 P0-2）**：

   ```
   TaskCheckpoint
     ├── taskFingerprint
     ├── status            # running / done / failed
     ├── leaseOwner        # 持有执行权的 runId
     ├── leaseExpiresAt    # lease 到期时间
     ├── attempt
     ├── resultRef         # 产物引用
     └── committedAt       # 原子提交时间
   ```

   1. 同一 taskFingerprint 同一时刻只能有一个有效执行者（lease 未过期即独占）
   2. Checkpoint **原子提交**（禁止部分写入）
   3. 执行者崩溃后，须等 lease 到期才可被其他 Run 接管
   4. 外部副作用使用独立幂等键，与 checkpoint 提交解耦
4. 任务级 resume：`workflow resume --tasks`——已完成任务跳过，只跑 failed/pending
5. per-task 重试策略（Plan budget.maxRetries / stage 覆盖）
6. 失败分类与恢复报告

**暂不纳入**（M4/M5）

- 任务的自适应重排（M4）、失败根因的 AI 分析（M5）

### 任务分解

| 任务 | 内容 | 交付物 | 验收 |
| --- | --- | --- | --- |
| M3-T1 TaskRegistry | 任务实例 Schema（taskFingerprint/status/leaseOwner/leaseExpiresAt/**leaseGeneration**/attempt/resultRef/committedAt）；存储于 `.pi/workflows/tasks/<workflowId>/`。**并发安全（评审 P0-2）**：同一 taskFingerprint 同一时刻只允许一个有效执行者（lease 未过期即独占）；崩溃 Run 的任务在 lease 到期后才可被其他 Run 接管；**每次接管 leaseGeneration+1（Fencing Token）** | `src/engine/governance/task-registry.ts` | 清单与实际执行一一对应；无双重执行；旧执行者恢复后无法覆盖新结果 |
| M3-T2 BatchExecutor | 清单驱动调度：静态清单（Plan stages）+ 动态登记（运行时 register）；复用现有 scheduler 并发配额 | `batch-executor.ts` | 48 任务清单按并发上限调度正确 |
| M3-T3 TaskCheckpoint | done 任务持久化（产物 + taskFingerprint 分层指纹 + **leaseGeneration**）；跨 run 按 taskFingerprint 复用判定；**提交原子 CAS**：提交须同时满足 leaseOwner 与 leaseGeneration 与当前持有者一致（检查与提交不可分割），旧执行者即使恢复也不能覆盖新执行者的结果（场景：A 暂停→lease 过期→B 接管完成→A 恢复提交被拒） | checkpoint 存取层 | 修改无关代码后 done 任务产物仍可复用；副作用状态可查；Fencing 生效 |
| M3-T4 任务级 resume | `workflow resume --tasks`：跳过 done（指纹一致），重跑 failed/pending；兼容现有 runId resume（两通道并存）；**并发安全**：resume Run 与新启动 Run 竞争同一任务时按 lease 接管语义执行（接管即 leaseGeneration+1），外部副作用走独立幂等键 | resume 扩展 | 部分失败场景恢复成功率 100%；多 Run 并发恢复无双重执行 |
| M3-T5 失败分类与恢复报告 | per-task 失败原因分类（可恢复/结构性/超限）；恢复报告（重跑清单/节省 token 数） | 恢复报告生成 | 报告与实际执行一致 |
| M3-T6 Benchmark | 48 组任务中 10 组失败的恢复对比（全量重跑 vs 任务级恢复的耗时/token） | `dev-docs/benchmark/m3-*.json` | 量化：token 节省 ≥ 失败比例 × 总量 |

### 验收指标

| 指标 | 目标 |
| --- | --- |
| 部分失败恢复的已完成任务重跑率 | 0% |
| 任务状态与实际执行一致性 | 100% |
| 指纹一致的已完成任务，正确复用率 | 100% |
| 指纹不一致的任务，旧产物复用率 | 0%（不允许错误复用） |
| 修改无关任务，对其他任务有效产物的影响 | 零影响 |
| 副作用未确认提交的任务，被判定为安全完成 | 不允许（0 例） |
| 静态清单 + 动态登记两种模式覆盖 | 均有测试 |

**依赖**：M1 Plan stages（静态清单来源）、M2 budget（per-task 重试上限）。

---

## M4 · Adaptive Execution（自适应执行）

**目标**：把 M1 Analyzer 的优化建议**自动化执行**（输入管理），并让调度与模型选择**依据真实数据自适应**。解决「token 浪费在重复上下文、资源利用率低」。

### 范围

**纳入**

1. **输入分片器**（确定性）：按大小/数量/业务边界标记分片（Analyzer OPT `input-reduction` 建议的自动化）
2. **上下文三层管理**（评审 P0-3：减少重复传输 ≠ 减少必要信息）：

   | 层次 | 内容 | 传递方式 |
   | --- | --- | --- |
   | Shared Context | 所有任务都需要的基础信息 | 公共引用 |
   | Task Context | 每个任务独有的输入 | 独立传递 |
   | Evidence Reference | 必须保留的原始证据 | 按需读取（不可因生成摘要而丢弃原始来源） |

   反例约束：48 个需求任务共享一份游戏规则文档时，**不得**把规则压缩成摘要后分发——可能丢失只对特定任务重要的规则细节。`mcp.call`/确定性 dedup 生成的公共摘要仅作为 Shared Context 层，Evidence Reference 层保留原始引用（Analyzer OPT-001 的自动化）
3. **AdaptiveScheduler**：按任务类型与 **M2/M3 已有运行观测数据**加权路由 tier（无历史样本时静态调度；M5 完成后接入正式性能基线）；波次重排（长任务先发）
4. **ModelPool 自适应**：按 429/超时/耗时信号动态升降档（复用 `model-pool.ts` 现有池）
5. **Plan execution.mode 策略执行器**：fast/balanced/quality 三模式的自动化策略（fast 砍验证、quality 加 verify）落地为可执行配置
6. 脚本 API：`mcp`/`agent` 之外新增 `shard(items, opts)` 分片 helper（可选使用）

**暂不纳入**（M5）

- 优化效果的历史评估、建议质量的回评

### 任务分解

| 任务 | 内容 | 交付物 | 验收 |
| --- | --- | --- | --- |
| M4-T1 输入分片器 | 确定性分片：按字节/条数/边界标记；分片结果确定性（同输入同分片） | `src/engine/adaptive/sharder.ts` | 分片覆盖 100%、无重复无遗漏 |
| M4-T2 公共上下文提取 | 前置合并（agent 或确定性 dedup）→ 引用传递（`ctx.common`） | common-context 执行器 | 重复注入 token 下降（对照 Benchmark） |
| M4-T3 AdaptiveScheduler | 第一版基于 **M2/M3 已有运行观测数据**建立轻量级任务耗时画像（无历史样本时静态调度）；长任务先发；M5 完成后接入正式性能基线 | `adaptive-scheduler.ts` | 混合长短任务的墙钟优于静态调度；无历史样本时行为正确 |
| M4-T4 ModelPool 自适应 | 429/超时信号 → 池内降档；恢复 → 升档 | model-pool 增强 | 人为注入 429 时自动切换且任务不失败 |
| M4-T5 mode 策略执行器 | **Effective Validation = Required Validation UNION Profile Validation**（Profile 只能增加或调整非强制验证，不能删除 Definition 强制项，详见架构基线 2.2）：fast 减少非必要验证与冗余评审（可提并发），quality 增加交叉验证与重复评审 | mode 策略执行器 | 三模式产生可观测的策略差异；三模式下 Required Validation 全部执行（PrdGameSkill：需求覆盖检查/关键结算规则验证/最终交付质量检查不可跳过） |
| M4-T6 Benchmark | 分片前后 token 对比、自适应 vs 静态调度墙钟对比、质量不降级验证 | `dev-docs/benchmark/m4-*.json` | 见验收指标 |

### 验收指标

| 指标 | 目标 |
| --- | --- |
| 重复上下文 token 降低 | ≥30%（PrdGameSkill S8 对照） |
| 混合任务墙钟 | 自适应 ≤ 静态调度（同并发） |
| 质量不降级 | verify/judge 通过率不低于基线；**证据覆盖率不下降**（Evidence Reference 层保证原始来源可按需读取） |
| 分片确定性 | 同输入同分片 100% |

**依赖**：M1 Analyzer 建议 Schema（自动化对象）、M3 TaskRegistry（分片任务登记）、**M2/M3 运行观测数据（轻量画像，不依赖 M5 基线）**。

---

## M5 · Continuous Optimization（持续优化）

**目标**：闭环——Evaluator 对比预估与实际、沉淀性能基线、基准常态化，让每次运行都让下一次更准。解决「无法持续衡量和优化」。

### 范围

**纳入**

1. **Evaluator**：Plan estimated vs actual 对比报告（偏差率、超预算项、失败分布）
2. **历史性能基线**：按 `workflowId + scriptHash` 聚合多 run 数据（趋势、回归检测）
3. **优化建议质量回评**：M1 OptimizationSuggestion 的 expectedImpact vs 实际（建议可信度评分）
4. **基准常态化**：Benchmark 测试集经 Schedule 定时执行（复用现有 schedule 机制）
5. **优化闭环工作流**：Evaluator 报告 → Analyzer 重分析 → 建议 → **授权闸门**（独立工作区修改，陷阱 3）→ 再评估

**暂不纳入**

- 自动无授权修改生产脚本（永久不做，陷阱 3）
- 跨项目基线迁移

### 任务分解

| 任务 | 内容 | 交付物 | 验收 |
| --- | --- | --- | --- |
| M5-T1 Evaluator 数据模型 | estimated/actual 对比、偏差率、超预算项 | `src/engine/evaluator/evaluator.ts` | 对比数据与 journal/M2 指标一致 |
| M5-T2 性能基线存储 | 按 workflowId+scriptHash 聚合多 run（趋势/回归检测） | baseline 存取层 | 同脚本回归可检测 |
| M5-T3 对比报告 | JSON + MD（预估 vs 实际、偏差率、优化建议回评） | 报告生成 | 同输入确定性输出 |
| M5-T4 基准常态化 | Benchmark 测试集经 Schedule 定时跑（复用 schedule） | schedule 配置 | 基准定期产出且可查 |
| M5-T5 优化闭环工作流 | Evaluator → Analyzer → 建议 → 授权 → 独立工作区修改 → Benchmark 对比 → 应用/放弃 | 闭环 workflow（复用 M3 任务级恢复） | 至少一个真实 workflow 跑通完整闭环 |
| M5-T6 验收 | PrdGameSkill S8/S10 的完整优化闭环 + 量化对比报告 | `dev-docs/benchmark/m5-final.md` | 见验收指标 |

### 验收指标

| 指标 | 目标 |
| --- | --- |
| 估算误差 | **同一 Workflow、同一类输入规模**下的预估 vs 真实偏差（跨规模不可比，不做递减类指标） |
| 耗时画像 | 按任务类型统计 P50/P90 耗时并可查询 |
| 回归检测准确率 | 人为注入性能回归可被检出（含误报率记录） |
| 优化闭环真实案例 | ≥1 个（含前后量化对比） |
| 建议可信度评分 | 高分建议的实际有效率 ≥80% |

**依赖**：M1-M4 全部交付物。

---

## 五点五、跨阶段能力：Workflow Execution Trace（评审新增）

PrdGameSkill 的核心痛点（跑 60 分钟失败却不知道慢在哪）**不是静态分析能完全回答的**——静态分析知道有 3 个并行任务，但不知道服务端任务 480s/32K token 才是真正瓶颈。

新增跨阶段能力 **Workflow Execution Trace**（静态分析 + 动态执行观测关联），分阶段演进、**不为它提前重构 Runtime**：

| 阶段 | Execution Trace 交付 |
| --- | --- |
| M1 | 静态 Analyzer + **读取已有 Journal 与执行报告，关联已有数据** |
| M2 | 结构化运行指标采集完善（per-agent 耗时/Token/失败） |
| M3 | 关联 TaskCheckpoint（任务级执行记录） |
| M5 | 跨 Run 正式性能基线 |

最终形态 **Workflow Performance Analyzer**：代码结构与真实执行数据关联，输出——哪个 Stage 最慢、哪个 Agent 消耗 Token 最多、哪些任务在等待、哪些可并行、哪些重复传递上下文、哪些失败后重复执行。让 Analyzer 真正回答"为什么慢、改哪里、改后是否变快"。

**统一关联 ID（五级层级，五轮评审补）**——静态分析的 Agent 节点与真实执行调用靠它对应，避免各阶段自造关联字段：

```
workflowId
  └── runId
       └── stageId
            └── taskKey
                 └── agentCallId   # 一次实际 Agent 调用
```

| ID | 职责 |
| --- | --- |
| workflowId | 标识工作流 |
| runId | 标识一次执行 |
| stageId | 标识执行阶段 |
| taskKey | 标识逻辑任务 |
| agentCallId | 标识一次实际 Agent 调用 |

M1-T0 先确认五级 ID 与现有 Journal（runId:callIndex/attempt）的兼容映射；M2/M3 在各自采集与登记中使用同一层级，不另发明字段。

**统一关联 ID（评审 P1，五级层级）**——静态分析的 Agent 节点与真实执行调用靠它对应，避免各阶段自造关联字段：

```
workflowId
  └── runId
       └── stageId
            └── taskKey
                 └── agentCallId   # 一次实际 Agent 调用
```

| ID | 职责 |
| --- | --- |
| workflowId | 标识工作流 |
| runId | 标识一次执行 |
| stageId | 标识执行阶段 |
| taskKey | 标识逻辑任务 |
| agentCallId | 标识一次实际 Agent 调用 |

M1-T0 先确认五级 ID 与现有 Journal（runId:callIndex/attempt）的兼容映射；M2/M3 在各自采集与登记中使用同一层级，不另发明字段。


## 六、跨阶段注意事项

1. **Runtime 挂钩点以可选 options 注入**（M2 budget-gate、M3 task 登记、M4 调度回调），旧脚本零改动可跑——每阶段回归跑 `tests/engine/`（206 断言）确保兼容。
2. **M4 直调 MCP 池与各阶段的关系**：`mcp-client-pool.ts` 是 M4（Adaptive）可优化的对象之一（如 MCP 调用也进 AdaptiveScheduler），但不在 M2/M3 范围。
3. **Journal 语义**：M3 TaskCheckpoint 与现有 runId resume 通道并存（两通道），不改变现有 journal 的 resume 回放语义。
4. **每阶段完成**：更新本文档状态表与架构基线（`design/workflow-engineering-framework.md`）路线图状态；PrdGameSkill 跑一轮真实对照并落报告到 `dev-docs/progress-result/`。
5. **文档同步**：`skills/workflow-authoring/SKILL.md` 随 M2（budget.remaining）/M4（shard helper）增量更新。

---

## 七、验收指标汇总（全阶段）

| 阶段 | 关键量化指标 | 目标 |
| --- | --- | --- |
| M1 | DSL 识别率 / 定位准确率 / 误报率 / 输出确定性 | 100% / ≥95% / ≤10% / 100% |
| M2 | 超限拦截率 / Plan 兼容性 / 指标完整性 | 100% / 100% / 100% |
| M3 | 已完成任务重跑率 / 跨 run 恢复成功率 | 0% / 100% |
| M4 | 重复上下文 token 降低 / 质量不降级 | ≥30% / 通过率不降 |
| M5 | 同类任务估算误差基线 / 回归检测 / 优化闭环 / 建议有效率 | 建立可量化基线 / 注入可检出+误报率 / ≥1 例 / ≥80% |

## 引用

- 架构基线：`dev-docs/design/workflow-engineering-framework.md`
- M1 细节计划：`dev-docs/planning/2026-11-18-workflow-engineering-execution-plan.md`
- 既有能力：`workflow-runtime.ts`（并发/重试/超时/Journal/子 workflow）、`model-pool.ts`（模型池）、`mcp-client-pool.ts`（M4 直调池）、`tests/engine/`（206 断言兼容回归基线）
