# M6 修复执行报告：审计问题修复

- 日期：2026-11-18
- 依据审计：`dev-docs/troubleshooting/2026-11-18-m1-m5-production-readiness-audit.md`
- 结论：**审计的 3 个 P0 与 8 个 P1 修复项全部完成**；新增 27 条回归断言（含 10 子进程真实竞争）

---

## 一、P0 修复（生产接线与并发安全）

| 审计问题 | 修复 | 验证 |
| --- | --- | --- |
| CLI `analyze` / `plan validate` 是死代码（SKILL 文档承诺落空） | `bin/pi-code-mode.js` 增加两子命令分发（经 tsx 调 src 实现，避免重复逻辑） | 实测 `pi-code-mode analyze <file> --md`、`plan validate <plan>` 均可用 |
| Plan/Budget 从未进真实 run（M2-M5 核心失效） | `workflow` 工具新增 `planPath`/`profile` → `resolvePlanContext` → 注入 `budgetGate`/`concurrency` | `plan-wiring.test.ts`：`maxAgents:1` 时**真实 run 只执行 1 个 agent**（此前从不生效） |
| schedule run 绕过 global gate / tier 池 / journal / Plan | `PiScheduleRunner` 补齐 `withGlobalGate`、`resolveTier(Pool)`、`JournalStore`、Plan 注入；新增 `adapterFactory` 注入缝 | `schedule-wiring.test.ts`：journal 真实落盘、gate 结束后归零 |
| TaskRegistry Fencing 跨进程失效（构造时快照） | 新增 `file-lock.ts`：`wx` 原子建锁 + stale 接管；`TaskRegistry.critical()` 每次临界区**重读磁盘**后 CAS | `fencing-crossprocess.test.ts`：**10 个真实子进程**抢同一任务恰好 1 个成功；旧持有者 commit 被拒 |
| `writeFileAtomic` 的 `rm→rename` 可致唯一 checkpoint 蒸发 | 改为 `tmp(fsync) → rename → 失败则 bak 中转 → 清理`，任何时刻磁盘至少有完整副本 | 覆写/替换测试，无 tmp 残留 |
| `workflowId` 未清洗写文件名、artifact safeName 碰撞 | registry 文件名 `safeName(workflowId)`；artifact 名插入 fingerprint 片段 | `../etc/evil` 不越界；`stage:1` vs `stage 1` 产物互不覆盖 |

## 二、P1 修复（正确性）

| 审计问题 | 修复 | 验证 |
| --- | --- | --- |
| BatchExecutor 缺 fingerprint 时只 hash taskKey → 静默复用陈旧产物 | 缺 fingerprint **明确失败**并说明原因 | `batch-safety.test.ts` |
| 任务无超时 + 无限续租 → 挂死任务永久占槽 | 新增 `taskTimeoutMs`；超时即失败、停续租、释放租约 | 超时 200ms 用例：失败 + `leaseExpiresAt=0` 可被接管 |
| 降级只改 policyState，limits 恒定；旧字段残留 | `PolicyState.degrade` 改为**整体替换**；`BudgetTracker.updateLimits` **只能收紧**（min 合并，目标未声明则保持） | 降级后 `concurrency/modelPolicy` 来自目标 Profile；limits 收紧且不清空 |
| `budgetDecision.policy` 生成后丢弃（降级无实效） | runtime 在 dispatch 前消费 `effectivePolicy`：调 `scheduler.setConcurrency` + `modelPolicy.writing` 走 tier 路由 | 引擎 206 断言零回归 |
| 超时/失败路径直接释放预留 → 漏计已产生 usage | 失败/中止路径若已有 usage 则按实际结算；成功路径区分真实/估算 | `runtime-budget` 全绿 |
| `estimateTokens = len/4` 对中文低估 2-3 倍 | 按 CJK 占比加权（CJK 1.5 字符/token，其他 4） | 中文 20 字 ≈14 token（旧约 5） |
| `nextDegradeTarget` 未知 Profile 直跳 fast | 未知 Profile → `balanced`（保持链式降级语义） | 断言覆盖 |
| 只传 planPath 时把 Plan JSON 当脚本哈希 → 永假 stale | `loadPlan` 空路径/目录不再当脚本；`resolvePlanContext`/`plan-tool` 无脚本时跳过过期判定 | `plan-runner`/`plan-tool` 16 断言全过 |
| `includeSuggestions:true` 静默无效（无 plannerAgent） | 新增 `createPlannerAgent()`（PiAgentAdapter 单次调用）并在扩展主入口注入；未配置时给显式 diagnostics | 扩展接线；工具层提示 |
| benchmark 仅 4 正向标注，五规则无覆盖 | 标注扩到 12 样本/9 正向，新增 4 个 fixture | **抓出并修复 3 个真实缺陷**（见下） |

## 三、benchmark 扩标注抓出的真实缺陷（价值证明）

补标注后 benchmark 立刻暴露三处：

1. **`.map` 未传播数组长度** → `new Array(48).fill(0).map(...)` 的循环上界丢失，CONC-001 漏报。修复：`staticArrayLength` 对 `.map` 传播接收者长度（filter/slice 仍保守 undefined）。
2. **`for (let i=0; i<N; i++)` 字面量上界未解析** → 25 次 agent 调用被当成 1 个任务。修复：解析 `BinaryExpression` 字面量上界。
3. **REC-001 用调用点数而非估算任务数** → 单调用点循环 25 次不被识别为大规模。修复：统一 `estimateTaskCount`（含循环上界）。

结果：M1 benchmark **recall 100%（9/9）、FPR 0%（0/4）**，12 个标注样本全 PASS；9 个真实脚本确定性输出不变。

## 四、回归验证

| 套件 | 结果 |
| --- | --- |
| `npm run build`（tsc） | 通过 |
| `npm run test:engine` | 206/206 |
| `npm run test:contract` | 93/93（含新增 plan-wiring 4、schedule-wiring 2） |
| tests/governance（8 文件） | 72/72（含 fencing-crossprocess 8、batch-safety 4、degrade-effective 5） |
| tests/plan（3 文件） | 30/30 |
| M1 benchmark | recall 100% / FPR 0% / 9 真实脚本确定性 |

## 五、仍未完成（诚实记录）

审计报告中的以下项**未在本次修复**，仍属 M6 待办：

1. **Adaptive 模块（M4）生产接线**：分片器/上下文三层/AdaptiveScheduler/AdaptiveModelPool 仍是库级——BatchExecutor 已可承接分片产物，但 runtime 尚未自动分片与调度重排。
2. **Evaluator 数据通路（M5）**：`BaselineStore.record()` 仍无生产调用方（run 结束未自动 evaluate + record）；优化闭环仍为注入式库 API。
3. **M4/M5 指标重测**：报告里的“token 降 100%”“墙钟不劣化”仍是库级算术，需真实 PrdGameSkill 跑一次对照才能声称生产达标。
4. **`resume --tasks` CLI**：任务级恢复只有 BatchExecutor API，尚未提供 CLI/工具入口。
5. 审计提到的 `limiter` 与 `semaphore.ts` 重复、`evaluator duration 串行求和`、`baseline 无上限增长` 等 P2 未处理。

**因此计划状态仍为「库级实现完成 + 核心生产接线已修（M2/M3 + schedule + CLI），M4/M5 生产化待办」。**

## 六、后续生产接线（本轮继续完成）

### M3 taskResume 真实入口

- `workflow` 工具新增 `taskResume: true` 参数；真实 run 接入 `TaskRegistry`
- agent call 使用稳定 taskKey + 完整指纹，第二次 run 复用已完成产物、零模型调用
- 接线测试：`tests/contract/task-resume-wiring.test.ts` 2/2

### M4 Adaptive 真实入口

- `parallel()` 支持可选 `adaptiveProfiles`（历史 TaskCheckpoint 画像），有画像时长任务先发，返回顺序不变
- workflow 工具 `taskResume` 模式自动从 TaskRegistry 构造画像并传入 runtime
- 分片/上下文三层 API 已可由调用方接入；不强制改变旧 workflow

### M5 Baseline 真实入口

- `runWorkflow` 增加可选 `evaluationPlan` + `baselineStore` + `onEvaluation`
- workflow 工具提供 Plan 时，run 完成自动聚合 AgentRecord → EvaluationReport → BaselineStore
- 接线测试：`tests/contract/evaluation-wiring.test.ts` 2/2
- 无 Plan 旧 workflow 不创建 baseline，兼容性保持

### M5 Optimize 工具入口

- 注册 `workflow_optimize` 工具：真实调用 Analyzer/Planner，优化默认走独立工作区和授权闸门
- 缺少 `patchedSource` / Benchmark 证据时不应用生产脚本
- 真实闭环的 Benchmark 执行器仍需业务侧注入（安全默认，不自动执行生产 workflow）

本轮接线回归：engine 206/206，contract 97/97，新增 M6 接线测试 22/22，build 通过。

## 七、继续生产化（本轮）

- **M3 taskResume**：workflow 工具 `taskResume:true` 已接 TaskRegistry；stable taskKey + 完整 fingerprint；第二次 run 复用 done 任务，不调用 Agent。接线测试 2/2。
- **M4 runtime 接线**：`parallel()` 可选消费 TaskCheckpoint 耗时画像；workflow `taskResume` 自动构造 adaptiveProfiles；长任务先发、返回顺序保持。分片/三层上下文 API 可继续按显式任务接入。
- **M5 Baseline 接线**：Plan workflow 完成后 `runWorkflow` 聚合 AgentRecord → `EvaluationReport` → `BaselineStore.record()`；接线测试 2/2。无 Plan 旧 workflow 不写基线。
- **M5 Optimize 入口**：新增 `workflow_optimize` 工具与 `pi-code-mode optimize <script> [--suggest]` CLI；真实调用 Analyzer/Planner，默认独立工作区+授权闸门，不直接改生产脚本。Planner 无完整 patch 时不会猜测整文件。

本轮回归：build 通过、engine 206/206、contract 97/97、M6 接线 15/15；M4/M5 库级模块已进入主要生产路径，但自动分片/parallel 完全接管与真实 Benchmark 执行器仍需显式配置/后续业务接线。
