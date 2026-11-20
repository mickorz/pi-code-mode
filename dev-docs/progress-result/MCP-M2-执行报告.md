# MCP-M2 执行报告：Execution Governance（执行治理）

- 日期：2026-11-18
- 架构基线：`dev-docs/design/workflow-engineering-framework.md`
- 执行计划：`dev-docs/planning/2026-11-18-workflow-engineering-execution-plan.md`
- 结论：**M2（T1-T7）全部完成**，量化验收指标全部达标

---

## 一、交付清单

| 任务 | 交付物 | 断言数 |
| --- | --- | --- |
| T1/T2/T2b 预算三分类 + 计量 | `src/engine/governance/budget-tracker.ts`、`tests/governance/budget.test.ts` | 13 |
| T3 预算闸 + 降级语义 | `src/engine/governance/{budget-gate,policy-state}.ts`、`tests/governance/budget-gate.test.ts` | 9 |
| T3 集成 runtime | `src/engine/runtime/workflow-runtime.ts`（dispatch 边界接入 + 结算/释放）、`tests/governance/runtime-budget.test.ts` | 6 |
| T4 Plan 执行消费 | `src/engine/plan/plan-runner.ts`、`tests/plan/plan-runner.test.ts` | 9 |
| T5 budget.remaining() 脚本 API | runtime globals 注入 `budget.{remaining,totals}` | （含上） |
| T6 工具与 CLI | `src/tools/plan-tool.ts`、`tests/plan/plan-tool.test.ts`、主入口注册 | 7 |
| T7 Benchmark | `tests/governance/m2-benchmark.mts`、`dev-docs/benchmark/m2-budget-benchmark.json` | 7 |

合计 **58 条 M2 断言全 PASS**；engine 206 / contract 87 零回归。

## 二、量化验收指标

| 指标 | 目标 | 实测 |
| --- | --- | --- |
| 预算超限拦截率（三类硬预算） | 100% | ✅ maxAgents / maxDurationMs / maxRetries 各拦截验证通过 |
| Plan 注入对旧 workflow 兼容性 | 100% | ✅ 未注入 gate 时行为逐字节不变；无 Plan 时 `resolvePlanContext` 返回 null |
| 运行指标完整性 | 100% | ✅ 聚合值 = 逐条 usage 之和（60 vs 60） |
| budget.remaining() 精度 | 与 tracker 一致 | ✅ 含预留占用（10000 - 400 reserved = 9600 等用例） |
| 软预算并发安全 | 无超发 | ✅ 5 并发 × 3000 / 上限 10000 → 仅 3 个成功 |

## 三、核心设计

### 预算三分类（架构基线与评审 P0-3）

| 类型 | 字段 | 执行策略 |
| --- | --- | --- |
| 硬预算 | maxAgents（总 dispatch 次数）/ maxDurationMs / maxRetries | dispatch 前拦截，超限即停（不可恢复） |
| 软预算 | maxInputTokens / maxOutputTokens | 调用前**原子预留** → usage 结算 → 超限降级 |
| 实际计量 | 模型返回 usage | 无 usage 时按预留值计入并标 `estimated=true`（不伪装精确） |

### Budget Reservation 五约束落实

① 原子预留（同步块，JS 单线程保证）② 并发不重复消费（input/output 分项占用）③ 失败释放（`outcome=failed/cancelled` 且无 usage）④ usage 结算差额 ⑤ 无真实 usage 标估算。

### 降级 Run 级语义（五轮评审 P1-2）

- `activeProfile`：本次 Run 初始 Profile（**不变**，用于追溯）
- `effectivePolicy`：当前生效策略（可降级变化）
- `policyTransitions`：每次变更 + 原因 + 时间
- 降级链 `quality → balanced → fast`（不可反向自动升级）；**强制验证 `requiredValidation` 恒生效，降级不可关闭**
- 降级只影响后续未调度任务（gate 在 dispatch 边界执行）

### Plan 执行消费（M2-T4）

`resolvePlanContext()` → `PlanRunContext`：读 Plan + 选 Profile（缺省 balanced）→ 生成 BudgetGate / concurrency（覆盖脚本 setConcurrency）/ modelPolicy / planHash / profileHash / notes（过期提示）。`toRunConfig()` 产出 `WorkflowRunConfig { workflowId, runId, planHash, activeProfile, profileHash, effectivePolicy, policyTransitions }`。

## 四、架构约束核对

| 约束 | 落实 |
| --- | --- |
| Runtime 挂钩点以可选 options 注入 | ✅ `budgetGate?: BudgetGate` 可选；未注入零影响（有专门兼容测试） |
| 降级不关闭强制验证 | ✅ `PolicyState.validationRequired` 恒取 Definition 值 |
| 收益/指标不虚构 | ✅ 无 usage 标 `estimated`；M2 指标来自真实记账 |
| 不破坏现有 Journal 语义 | ✅ 未改动 journal 写入路径，206 引擎断言零回归 |

## 五、下一步（M3 Reliable Execution）

M2 已提供 M3 需要的两个基础：
1. **指标采集**（per-agent usage 聚合）→ M3 任务级耗时画像的输入
2. **RunConfig 追溯**（activeProfile/transitions）→ 任务级恢复时的策略重现

M3 任务：TaskRegistry（含 `leaseGeneration` Fencing Token）+ BatchExecutor + TaskCheckpoint（分层指纹 taskFingerprint + 外部副作用四状态）+ Registry/Checkpoint 一致性五规则 + 任务级 resume。
