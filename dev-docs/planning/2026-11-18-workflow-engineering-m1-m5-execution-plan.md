# Workflow Engineering Framework：M1-M5 完整执行计划

- 日期：2026-11-18
- 架构基线：`dev-docs/design/workflow-engineering-framework.md`（五层框架、三条原则、六条陷阱约束——本文档全部任务受其约束）
- M1 细节计划：`dev-docs/planning/2026-11-18-workflow-engineering-m1-execution-plan.md`（本文档 M1 章节仅存状态与摘要，避免双源漂移）
- 执行顺序：**M1 → M2 → M3 → M4 → M5 串行**，每阶段依赖前置交付物；PrdGameSkill 为贯穿全部阶段的真实测试项目

---

## 总览

| 阶段 | 名称 | 核心交付 | 解决的问题 | 状态 |
| --- | --- | --- | --- | --- |
| M1 | Workflow Intelligence | Plan Schema + Analyzer + Optimization Planner + Benchmark | 不知道 Workflow 为什么慢、如何改 | 已规划（细节见 M1 细节计划，待启动 T0） |
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

- 细节计划：`dev-docs/planning/2026-11-18-workflow-engineering-m1-execution-plan.md`（范围 / T0-T8 / Benchmark 三测试组 / 量化验收指标，以该文件为准）
- 状态：已规划，待启动 T0
- 对后续阶段的接口承诺（M2-M5 依赖这些产物）：
  - `WorkflowPlan`（JSON Schema，含 source.execution.mode/concurrency/modelPolicy、budget、stages）
  - `AnalysisReport`（JSON，findings 带 ruleId/severity/location/evidence）
  - `OptimizationSuggestion`（Schema，含 expectedImpact/qualityRisk/validation）

---

## M2 · Execution Governance（执行治理）

**目标**：让 Plan 真正被 Runtime 消费——预算可控、超限有策略、运行指标完整。解决「workflow 运行失控、成本不可控」。

### 范围

**纳入**

1. Budget 强制执行：`Plan.budget`（maxAgents/maxDurationMs/maxInputTokens/maxOutputTokens/maxRetries）在 Runtime 侧生效
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
| M2-T3 预算强制执行 | run 级 maxDurationMs / maxAgents / token 上限闸；agent dispatch 前检查，超限按策略分类（可恢复失败 / 终止） | `budget-gate.ts` 注入 runtime（可选 options，旧脚本零改动） | 超限 100% 拦截；旧 workflow 兼容 |
| M2-T4 Plan 执行消费 | `runWorkflow({ planPath })`：读 Plan → 注入 mode/concurrency/modelPolicy/budget | plan-runner 集成 | 同一 JS + 不同 Plan 产生不同执行策略 |
| M2-T5 budget.remaining() 脚本 API | VM 注入余量查询（供脚本自主降级） | globals 注入 | 脚本内可读余量并分支 |
| M2-T6 工具与 CLI | `workflow run --plan`、`workflow plan validate` 命令 | 工具扩展 | CLI 与工具同一 Plan Core |
| M2-T7 Benchmark | 预算强制用例（超 token/超时/超 agent 数）；Plan 注入对旧 workflow 的兼容回归 | `dev-docs/benchmark/m2-*.json` | 量化验收达成 |

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
3. **TaskCheckpoint**：任务级检查点持久化——跨 run 恢复的依据（按 `workflowId + scriptHash + taskKey` 关联，突破现有 resume 的 runId 隔离）
4. 任务级 resume：`workflow resume --tasks`——已完成任务跳过，只跑 failed/pending
5. per-task 重试策略（Plan budget.maxRetries / stage 覆盖）
6. 失败分类与恢复报告

**暂不纳入**（M4/M5）

- 任务的自适应重排（M4）、失败根因的 AI 分析（M5）

### 任务分解

| 任务 | 内容 | 交付物 | 验收 |
| --- | --- | --- | --- |
| M3-T1 TaskRegistry | 任务实例 Schema（taskKey/hash/状态/产物引用）；存储于 `.pi/workflows/tasks/<workflowId>/` | `src/engine/governance/task-registry.ts` | 清单与实际执行一一对应 |
| M3-T2 BatchExecutor | 清单驱动调度：静态清单（Plan stages）+ 动态登记（运行时 register）；复用现有 scheduler 并发配额 | `batch-executor.ts` | 48 任务清单按并发上限调度正确 |
| M3-T3 TaskCheckpoint | done 任务持久化（产物 + hash）；跨 run 按 workflowId+scriptHash 恢复 | checkpoint 存取层 | 重跑同 workflow 时 done 任务零执行 |
| M3-T4 任务级 resume | `workflow resume --tasks`：跳过 done，重跑 failed/pending；兼容现有 runId resume（两通道并存） | resume 扩展 | 部分失败场景恢复成功率 100% |
| M3-T5 失败分类与恢复报告 | per-task 失败原因分类（可恢复/结构性/超限）；恢复报告（重跑清单/节省 token 数） | 恢复报告生成 | 报告与实际执行一致 |
| M3-T6 Benchmark | 48 组任务中 10 组失败的恢复对比（全量重跑 vs 任务级恢复的耗时/token） | `dev-docs/benchmark/m3-*.json` | 量化：token 节省 ≥ 失败比例 × 总量 |

### 验收指标

| 指标 | 目标 |
| --- | --- |
| 部分失败恢复的已完成任务重跑率 | 0% |
| 任务状态与实际执行一致性 | 100% |
| 跨 run 恢复（同 workflowId+hash）成功率 | 100% |
| 静态清单 + 动态登记两种模式覆盖 | 均有测试 |

**依赖**：M1 Plan stages（静态清单来源）、M2 budget（per-task 重试上限）。

---

## M4 · Adaptive Execution（自适应执行）

**目标**：把 M1 Analyzer 的优化建议**自动化执行**（输入管理），并让调度与模型选择**依据真实数据自适应**。解决「token 浪费在重复上下文、资源利用率低」。

### 范围

**纳入**

1. **输入分片器**（确定性）：按大小/数量/业务边界标记分片（Analyzer OPT `input-reduction` 建议的自动化）
2. **公共上下文提取执行**：前置 agent/确定性合并生成公共摘要 + 引用传递（Analyzer OPT-001 的自动化）
3. **AdaptiveScheduler**：按任务类型与 M5 历史耗时加权路由 tier；波次重排（长任务先发）
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
| M4-T3 AdaptiveScheduler | 按 Evaluator/M5 前的历史耗时加权路由；长任务先发 | `adaptive-scheduler.ts` | 混合长短任务的墙钟优于静态调度 |
| M4-T4 ModelPool 自适应 | 429/超时信号 → 池内降档；恢复 → 升档 | model-pool 增强 | 人为注入 429 时自动切换且任务不失败 |
| M4-T5 mode 策略执行器 | fast/balanced/quality 的验证增减、冗余评审配置化 | mode 策略执行器 | 三模式产生可观测的策略差异 |
| M4-T6 Benchmark | 分片前后 token 对比、自适应 vs 静态调度墙钟对比、质量不降级验证 | `dev-docs/benchmark/m4-*.json` | 见验收指标 |

### 验收指标

| 指标 | 目标 |
| --- | --- |
| 重复上下文 token 降低 | ≥30%（PrdGameSkill S8 对照） |
| 混合任务墙钟 | 自适应 ≤ 静态调度（同并发） |
| 质量不降级 | verify/judge 通过率不低于基线 |
| 分片确定性 | 同输入同分片 100% |

**依赖**：M1 Analyzer 建议 Schema（自动化对象）、M3 TaskRegistry（分片任务登记）、M2 指标（自适应依据）。

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
| estimated 偏差率随迭代收敛 | 连续 3 轮递减 |
| 优化闭环真实案例 | ≥1 个（含前后量化对比） |
| 建议可信度评分 | 高分建议的实际有效率 ≥80% |
| 基线回归检测 | 人为注入性能回归可被检出 |

**依赖**：M1-M4 全部交付物。

---

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
| M5 | 偏差率收敛 / 优化闭环案例 / 建议有效率 | 3 轮递减 / ≥1 例 / ≥80% |

## 引用

- 架构基线：`dev-docs/design/workflow-engineering-framework.md`
- M1 细节计划：`dev-docs/planning/2026-11-18-workflow-engineering-m1-execution-plan.md`
- 既有能力：`workflow-runtime.ts`（并发/重试/超时/Journal/子 workflow）、`model-pool.ts`（模型池）、`mcp-client-pool.ts`（M4 直调池）、`tests/engine/`（206 断言兼容回归基线）
