# M1-M5 独立工程审计报告

- 日期：2026-11-18
- 审计范围：`dev-docs/planning/2026-11-18-workflow-engineering-execution-plan.md` 的 M1-M5 承诺，对照当前 `src/`、`extensions/`、`bin/` 与测试实现
- 方法：不以执行报告结论为依据；从生产入口（bin / extension tools / schedule runner / workflow runtime）反向追踪，再核验测试覆盖
- 结论：**库级实现与单元测试通过；生产接线不通过。M1 局部可用，M2-M5 的核心能力多数“造了引擎但未接上真实 workflow 执行入口”。当前不应继续标为“全部完成”。**

---

## 一、结论摘要与风险等级

| 范围 | 库级测试 | 生产接线 | 审计结论 |
| --- | --- | --- | --- |
| M1 Analyzer / Plan | 大部分通过 | Pi 工具已注册；CLI/AI Planner 未接线 | **部分通过** |
| M2 Budget / Plan Runner | 单测通过 | workflow / schedule 实行路径未注入 | **不通过（P0）** |
| M3 TaskRegistry / BatchExecutor | 单测通过 | BatchExecutor 生产零调用；Fencing 跨进程不成立 | **不通过（P0）** |
| M4 Adaptive | 单测/benchmark 通过 | adaptive 模块生产零调用 | **库级通过，生产未完成（P1）** |
| M5 Evaluator / Baseline / Loop | 单测/benchmark 通过 | record/loop 生产零调用 | **库级通过，生产未完成（P1）** |

**必须修复后才能把 M1-M5 重新标记为完成的 P0：**

1. 生产 `workflow` / schedule 入口接入 `resolvePlanContext`、BudgetGate、PlanRunConfig 与 Journal（M2）。
2. TaskRegistry 改成跨进程安全的 acquire/commit（文件锁或 CAS 事务；当前内存快照 Fencing 不成立）（M3）。
3. BatchExecutor/TaskRegistry 从测试库接到生产任务入口，或明确将 M3 降级为“库级原型”。

---

## 二、生产入口审计

### 2.1 已接线入口

| 能力 | 接线证据 |
| --- | --- |
| `workflow_analyze` Pi 工具 | `extensions/pi-code-mode.ts:155` 注册 `createWorkflowAnalyzeTool({ cwd })` |
| `plan_validate` Pi 工具 | `extensions/pi-code-mode.ts:157` 注册 `createPlanValidateTool({ cwd })` |
| M4/M5 之前已有的 Schedule | `extensions/pi-code-mode.ts:160-168` 启动 `ScheduleRuntime` 并注册 schedule tools |
| 既有 ModelPool | extension 建池 → `workflow-tools.ts` → `workflow-runtime.ts` 的 tierPool.acquire |
| 既有 SharedScheduler | `workflow-runtime.ts` 内 agent dispatch 使用 |

### 2.2 未接线入口（计划承诺与实际不符）

| 承诺 | 实际证据 | 影响 |
| --- | --- | --- |
| `pi-code-mode analyze <script>`（M1-T6 / Skill 文档） | `runAnalyzeCli` 在 `src/tools/workflow-analyze-tool.ts:182`，但 `bin/pi-code-mode.js` 无 `analyze` 分发 | 用户无法使用文档承诺的 CLI |
| `--suggest` AI Planner（M1-T5/T6） | 工具需 `plannerAgent` 才执行建议；主入口只传 `{cwd}`，未注入模型调用器；CLI `--suggest` 无接线 | `includeSuggestions:true` 静默只返回静态报告 |
| `workflow run --plan`（M2-T4/T6） | `resolvePlanContext` 仅 plan_validate 用；`WorkflowRunOptions` 无 planPath/profile；`workflow-tools.ts runOpts()` 无 `budgetGate` | Plan 不影响实际 run |
| 预算治理（M2-T3） | Runtime 有可选 `budgetGate` hook，但 workflow/schedule 生产 run 均不传 | 预算闸在真实运行中永不执行 |
| 任务级 `resume --tasks`（M3-T4） | 全仓无 `--tasks` 生产命令；BatchExecutor 只在 tests/benchmark | 生产仍只有 Journal 的 runId resume |
| M4 Adaptive 模块 | `src/engine/adaptive/*` 的唯一引用为 tests | 分片、上下文三层、调度、模型自适应零生产效果 |
| M5 Evaluator / Baseline / Loop | `src/engine/evaluator/*` 的唯一引用为 tests | 生产 run 永不写 baseline；回归检测/闭环生产不可达 |

---

## 三、P0：M2 的 Budget/Plan 未进真实运行路径

### 发现

`workflow-runtime.ts` 的 `budgetGate?: BudgetGate` 与 dispatch 拦截实现存在且测试通过；但生产调用方未传入它：

- `src/tools/workflow-tools.ts:139-153` 的 `runOpts()` 不调用 `resolvePlanContext`、不传 `budgetGate`
- `src/manager/pi-schedule-runner.ts:73-97` 调 `runWorkflow` 也不传 `budgetGate`、`resolveTier`、`resolveTierPool`、`onAgentJournal`
- `resolvePlanContext` 的生产调用点仅 `src/tools/plan-tool.ts`（校验展示），并不运行 workflow

### 后果

- `Plan.budget`、`activeProfile`、`effectivePolicy`、`policyTransitions` 都只是库测试对象
- `budget.remaining()` 在真实 workflow 中总返回空对象/零 totals
- schedule run 绕过全局 gate、tier pool、journal；手动 run 与 schedule 并发时可超过全局并发承诺

### 修复要求

1. 扩展 workflow 工具参数：`planPath` / `profile`。
2. `workflow-tools.ts` 在 run 前 `resolvePlanContext({ scriptPath, planPath, profile, runId })`，把 `budgetGate`、并发、tier/model policy 注入 `runWorkflow`。
3. schedule runner 复用同一 `makeRunOptions` 工厂（不要复制一套 runWorkflow 参数），带上 global gate / tier pool / journal。
4. Run result / journal / RunManager 记录 `WorkflowRunConfig`。

---

## 四、P0：M3 Fencing 非跨进程安全

### 发现

`TaskRegistry` 在构造时只调用一次 `load()`（`task-registry.ts:105-112`）。随后 acquire/renew/commit 全部读取内存 `this.data` 并写文件：

```
Run A 构造 Registry → data = 空
Run B 构造 Registry → data = 空
Run A acquire(gen=1) → 写盘
Run B acquire(gen=1) → 自己内存仍是空 → 也写盘
Run A commit → 自己内存认为自己 gen=1 → 成功
Run B commit → 自己内存也认为自己 gen=1 → 成功（后写覆盖）
```

当前 Fencing 只在“对手 acquire 已落盘、且第二个 Registry **之后**才构造”这个幸运时序下成立。

`batch-executor.test.ts` 的并发测试被同步 JavaScript 时序掩盖：runA 在 acquire 写盘后 runB 才构造；且断言 `calls <= 2` 容忍双重执行，`if (loser)` 条件断言也会放过双 done。

### 修复要求

1. acquire / renew / commit 采用**跨进程互斥**：文件锁（lock file `wx` + lease）或单独 sqlite/kv transaction；“读→比较→写”必须在同一临界区。
2. commit CAS 必须在临界区内从磁盘最新 state 校验 `leaseOwner + leaseGeneration`。
3. Windows `writeFileAtomic` 的 `rm(target) → rename(tmp)` 崩溃窗口需修复；至少保留 backup/recovery，不可让唯一 checkpoint 文件蒸发。
4. `workflowId` 进入文件名需 safeName，artifact 名需包含 `taskFingerprint` 片段，避免 safeName 碰撞覆盖。
5. 新测试必须用两个**提前构造**的 Registry（或 child process）复现竞争，不得用单线程 `Promise.all` 假并发。

---

## 五、P1：恢复/预算/调度实现缺口

### 5.1 Task 指纹默认值危险

`BatchExecutor` 不传 fingerprint 时仅 hash `taskKey`（与注释“taskKey + 运行时 prompt”不符）。而 `planShardedTasks()` 用位置键 `shard-0/1...`，两者直接对接会在输入改变后静默复用陈旧产物。

**修复**：fingerprint 必填，或由 BatchExecutor 对 `TaskContext` 内容 / shared evidence / model config 自动构造完整七元组；不允许只 taskKey 复用。

### 5.2 动态降级没真正改变运行行为

- `PolicyState.degrade()` 使用 `{ ...current, ...nextPolicy }`，后续 fast policy 未声明的 quality 字段残留
- BudgetTracker limits 在构造时固定，降档后预算不变
- `budgetDecision.policy` 在 runtime 中生成后未被消费去改并发或模型
- `nextDegradeTarget` 对未知 profile 直接跳 fast，跳过 balanced

**修复**：降级时整体替换为目标 resolved profile（再叠加不可变 Required）；更新 BudgetTracker 可用 limits；在 dispatch 边界消费 effectivePolicy（并发/模型）；未知 profile 走明确映射或拒绝自动降级。

### 5.3 超时与用量结算竞态

timeout/abort 后预留被 release；底层 session 仍可能异步上报 usage，当前 afterDispatch 已不再结算，导致软预算漏计。

**修复**：reservation 状态允许 `released-pending-usage`，最终 usage 到达后仍做一次实际结算；或强制等 session 真正 settle 后释放。

### 5.4 估算偏差

`estimateTokens = text.length/4` 对中文明显低估。应以模型/tokenizer 可用时的估算器替代；无 tokenizer 时按保守字符比率并标注估算误差范围。

---

## 六、P1：M4/M5 是库级能力，报告指标非真实实测

| 报告表述 | 实际测试 | 审计结论 |
| --- | --- | --- |
| M4 “混合任务墙钟不劣于静态” | 只断言排序 `long` 在前，无 wall-clock | 未证明 |
| M4 “重复上下文 token 降低 100%” | `estimateSavings(50000)` 纯算术，50KB 为手工输入 | 未证明真实 token 节省 |
| M4 “质量不降级” | 只比对验证字符串数组 | 未执行验证 |
| M5 “性能基线/回归检测” | BaselineStore.record 生产零调用 | 生产无基线 |
| M5 “优化闭环” | 所有 analyze/propose/benchmark 为注入 fake | 编排测试通过，真实闭环未运行 |

### 修复/重新分级建议

在生产接线前，M4/M5 报告状态改为“**库级实现完成，生产接线待 M6 Integration**”；不能称“量化验收达标”。

应新增 **M6 · Production Integration**（不是新架构能力，而是把 M2-M5 接到真实入口的接线/验收阶段）：

1. workflow/schedule 统一 run options 工厂
2. Plan/Budget/Task/Adaptive/Evaluator 逐步接线
3. 真实 PrdGameSkill S8/S10 对照（实际 wall-clock / token / 需求覆盖）
4. Schedule 定时基准注册，BaselineStore 有真实生产样本

---

## 七、M1 局部缺口

1. CLI 文档与实际不一致：`pi-code-mode analyze`、`pi-code-mode plan validate` 文档化但 bin 未分发；应接线或删除文档。
2. AI planner 无生产模型注入：`includeSuggestions:true` 静默无效果；应注入真实 plannerAgent 或返回“当前入口未配置 Planner”的显式错误。
3. benchmark 统计口径不足：M1 “recall 100/FPR 0”仅 4 个正向 / 4 个负向原子标注；五条规则无正向标注，不能作为全规则准确率。
4. Plan loader path-only 分支：只传 planPath 时把 plan JSON 当 script hash，可能永久 stale。

---

## 八、建议的修复顺序

1. **P0 接线**：M2 Plan/Budget/Journal 接入 workflow + schedule；修 CLI。
2. **P0 并发安全**：TaskRegistry 跨进程锁/CAS；修路径与原子写；强化并发测试。
3. **P1 正确性**：默认 fingerprint、降级生效、超时 usage 结算、token 估算。
4. **M6 真实接线验收**：生产接线与真实 PrdGameSkill Benchmark。
5. 再把 M1-M5 的状态重新标记为“生产完成”。

## 引用

- 执行计划：`dev-docs/planning/2026-11-18-workflow-engineering-execution-plan.md`
- 执行报告：`dev-docs/progress-result/MCP-M1-执行报告.md` 至 `MCP-M5-执行报告.md`
- 关键文件：`src/tools/workflow-tools.ts`、`src/manager/pi-schedule-runner.ts`、`src/engine/governance/task-registry.ts`、`src/engine/governance/batch-executor.ts`、`src/engine/runtime/workflow-runtime.ts`

## 八、审计后续修复状态（追加审计）

本轮审计发现的 M6 新问题已修复：

- H1 auto-shard 不安全 fingerprint：opaque thunk 不再跨 run 伪造复用；taskResume 只对稳定 agent taskKey 生效
- H2 abort/失败语义：auto-shard 的可恢复错误不再塌缩为 done/null；中止检查保留，避免 BatchExecutor 吞掉 abort
- H3 null 永久冻结：auto-shard 任务失败不提交 done/null checkpoint
- H4 taskResume 绕过 replayPolicy：任务级复用尊重 explicit replayable 策略
- M1 taskResume schema：workflow 工具参数已公开 `taskResume`
- M2 auto-shard workflowId：不再使用 runId 作为任务文件身份
- M3 画像来源：autoAdaptive 默认从 TaskCheckpoint 加载，parallel 可消费历史画像
- M4 Benchmark：Required Validation unknown 不再默认放行；支持 afterScriptPath 真实 before/after 对照
- M5 Baseline：run 后先检测历史回归，再写当前样本，避免当前样本稀释自身

验证：engine 206/206、contract 110/110、M6 接线测试 25/25。仍需注意：auto-shard opaque thunk 不能安全跨 run 复用，这是保守拒绝，不是错误复用；真实 Benchmark 仍需业务 workflow 提供 validation 结果。
