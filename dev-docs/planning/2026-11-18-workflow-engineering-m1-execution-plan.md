# M1 执行计划 — Workflow Intelligence：工作流理解与性能分析

- 日期：2026-11-18
- 架构基线：`dev-docs/design/workflow-engineering-framework.md`（本文档不重复架构论证）
- 阶段目标：**先让 pi-code-mode 能够理解一个 Workflow、分析它的执行结构、发现性能风险、生成优化方案，并指导 Agent 修改 Workflow JS**
- 明确不做：不改造 Runtime 核心执行机制、不引入新执行 DSL、不实现自动并发调度（避免一次性改动过多基础设施，同时先解决 PrdGameSkill 长耗时问题）

---

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

### T0：基线与测试样本

**工作内容**

- 检查当前 Analyzer 相关基础设施
- 确认 Acorn AST 能力与现有 VM 解析逻辑的复用边界
- 建立 Workflow 测试样本
- 收集 PrdGameSkill 中长耗时 Workflow 的实际脚本
- 保存优化前的运行数据

**交付物**：`dev-docs/design/m1-baseline.md`、`tests/analyzer/fixtures/`、`dev-docs/benchmark/m1-baseline.json`

**验收**：能够使用真实 Workflow 重现至少三种性能风险。

### T1：Workflow Plan

**工作内容**

- 定义 Plan JSON Schema
- 定义 sourceHash
- 实现 Plan Loader / Plan Validator
- 实现 Plan 与 Workflow JS 的关联
- 支持旧 Workflow 没有 Plan 的情况

**交付物**：`src/engine/plan/`、`tests/plan/`

**验收**：合法 Plan 可读取；非法 Plan 可定位错误；JS 修改后能发现 Plan 过期；没有 Plan 的旧 Workflow 正常工作。

### T2：AST Analyzer

**工作内容**

- 复用 Acorn
- 识别 agent / parallel / pipeline / sequence / fallback / race 调用
- 识别 workflow 子流程调用
- 提取调用参数和代码位置
- 建立 Call Graph 与初步依赖关系

**交付物**：`src/engine/analyzer/ast-parser.ts`、`call-graph.ts`、`dependency-analyzer.ts`

**验收**：准确统计已知 DSL 调用；还原直接可识别的串行/并行结构；动态表达式标记 unknown 不猜测；输出有来源位置的调用图。

### T3：性能规则引擎

**工作内容**

- 输入规模检测 / 重复上下文检测 / 并发波次估算 / 超时风险 / 重试风险 / 确定性操作识别 / 恢复能力检测
- 规则严重程度和置信度

**交付物**：`src/engine/analyzer/rules/`、`rule-engine.ts`

**验收**：每条风险有 ruleId、能定位代码；不确定的结果明确标注；有测试证明不会把合法串行流程误判为确定的性能缺陷。

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

**交付物**：`skills/workflow-authoring/SKILL.md` 更新（+ references/workflow-plan.md、analyzer-rules.md）

**验收**：Agent 创建或修改 Workflow 时，自动执行静态分析并根据报告修正问题。

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
| 已支持 DSL 节点识别率 | 100% |
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

## 六、引用

- 架构基线：`dev-docs/design/workflow-engineering-framework.md`
- 复用资产：`src/engine/runtime/vm.ts`、`workflow-runtime.ts`、`src/engine/persistence/journal.ts`、`src/engine/agent/model-pool.ts`、`src/tools/workflow-tools.ts`、`skills/workflow-authoring/`
- 外部测试样本：PrdGameSkill 仓库（`8-difference-review.js`、`10-unified-spec.js`、`game-prd-check.js`、`output-spec-generate`）
