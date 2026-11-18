# MCP-M3 执行报告：Reliable Execution（可靠执行）

- 日期：2026-11-18
- 架构基线：`dev-docs/design/workflow-engineering-framework.md`
- 执行计划：`dev-docs/planning/2026-11-18-workflow-engineering-execution-plan.md`
- 结论：**M3（T1-T4、T6）全部完成**，量化验收指标全部达标

---

## 一、交付清单

| 任务 | 交付物 | 断言数 |
| --- | --- | --- |
| T1 TaskRegistry + Fencing | `src/engine/governance/task-registry.ts`（lease/leaseGeneration/原子提交/一致性重建） | （与 T3 合并 16） |
| T3 TaskCheckpoint 分层指纹 | `src/engine/governance/task-fingerprint.ts` + registry 复用判定 | 16 |
| T2 BatchExecutor | `src/engine/governance/batch-executor.ts`（清单驱动/并发限流/重试/恢复报告） | （与 T4 合并 11） |
| T4 任务级 resume | executor 内 `resume` 语义 + `force` 强制重跑 | 11 |
| T6 Benchmark | `tests/governance/m3-benchmark.mts`、`dev-docs/benchmark/m3-recovery-benchmark.json` | 13 |

合计 **27 条 M3 断言 + 13 条 Benchmark 全 PASS**；engine 206 零回归。

## 二、量化验收指标

| 指标 | 目标 | 实测 |
| --- | --- | --- |
| 指纹一致的已完成任务，正确复用率 | 100% | ✅ 48 任务场景复用 38/38 |
| 指纹不一致的任务，旧产物复用率 | 0% | ✅ 改 prompt 指纹后 `reused=0` |
| 修改无关任务，对其他任务有效产物影响 | 零影响 | ✅ 整体脚本变动不失效；跨任务外部依赖隔离 |
| 部分失败恢复的已完成任务重跑率 | **0%** | ✅ 首轮 48 执行/10 失败 → resume 只执行 10，calls=10 |
| 跨 run 恢复成功率 | 100% | ✅ 新 BatchExecutor 实例读回 checkpoint 后 48/48 成功 |
| 副作用未确认提交的任务被判定安全完成 | 不允许 | ✅ `side-effect-unconfirmed` 拒绝复用 |

## 三、核心设计

### 分层指纹（七元组，整体 scriptHash 不参与复用）

```
taskFingerprint = hash({
  taskKey,
  taskDefinitionHash, taskDefinitionHash,
  inputHash, promptHash,
  modelConfigHash,          // 模型 ID + 关键参数（不只看模型名）
  executionContractVersion, // 输出契约版本
  externalDepsHash,         // 任务级：只含该任务声明的依赖
})
```

**验证的真实价值**：48 任务场景下修改一段无关日志代码，整体 scriptHash 会变，但 38 个已完成任务产物**仍然复用**（这是分层指纹相对整体 scriptHash 的核心收益，正是执行计划 P0-2 要解决的问题）。

### Fencing Token（P0-2）

- 每次 lease 接管 `leaseGeneration + 1`
- 提交时原子校验 `leaseOwner` + `leaseGeneration` 双字段
- 验证场景：A 暂停 → 租约过期 → B 接管（gen=2）提交 → A 恢复用 gen=1 提交 → **被拒 `lease-lost`**，结果保持 B 的产物

### Registry/Checkpoint 一致性（五规则）

① Checkpoint 为最终事实源；② 产物临时文件+原子替换；③ 提交前校验 `resultRef` 存在；④ 副作用状态独立（`sideEffectCommitted` 与 checkpoint 提交解耦）；⑤ `rebuildFromCheckpoints()` 把「done 但产物缺失」降级为 failed。

### 外部副作用四状态

`executed` / `artifactPersisted` / `sideEffectCommitted` / `idempotent`（+ `idempotencyKey`）。非幂等且副作用未确认 → **拒绝复用**（防崩溃后重复发布）。

## 四、架构约束核对

| 约束 | 落实 |
| --- | --- |
| Journal 语义不被破坏 | ✅ M3 独立于 journal：Journal 管 agent 回放，Checkpoint 管任务产物（两通道并存），engine 206 断言零回归 |
| 四系统职责独立 | ✅ TaskRegistry/TaskCheckpoint 独立文件（`.pi/workflows/tasks/<workflowId>.tasks.json` + `artifacts/`） |
| 不为恢复改造 Runtime 为调度系统 | ✅ Executor 在 runtime 之外，任务执行器由调用方注入 |

## 五、已知限制（诚实记录）

1. **BatchExecutor 与 workflow vm 尚未自动接线**：目前是独立执行器，需要调用方把「分片任务」映射为 `BatchTask`（每任务一个 `run()`）。与 `agent()`/`parallel()` 的自动任务登记（动态登记模式）留待 M4 与输入分片器一起做——M4 的分片器天然产出任务清单。
2. **租约续期需调用方显式 `renew()`**：超长任务（>10 分钟，T0 基线里真实存在 59 分钟的单 agent）需要调用方周期性续租，否则会被其他 Run 接管。M4 集成时应在执行器内部按租约 1/3 周期自动续租。
3. **恢复报告为文本**：`report()` 输出 Markdown，尚未接入 TUI 面板。

## 六、下一步（M4 Adaptive Execution）

M4 需要的 M3 基础已就绪：任务清单（BatchTask）+ 任务级指纹 + 任务级复用。M4 任务：输入分片器（产出 BatchTask 清单，接通 M3）→ 租约自动续期 → AdaptiveScheduler（消费 M2/M3 耗时数据）→ ModelPool 自适应 → 上下文三层（Shared/Task/Evidence Reference）。
