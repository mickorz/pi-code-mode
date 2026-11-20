# MCP-M4 执行报告：Adaptive Execution（自适应执行）

- 日期：2026-11-18
- 架构基线：`dev-docs/design/workflow-engineering-framework.md`
- 执行计划：`dev-docs/planning/2026-11-18-workflow-engineering-execution-plan.md`
- 结论：**M4（T1-T6）全部完成**，量化验收指标全部达标

---

## 一、交付清单

| 任务 | 交付物 | 断言数 |
| --- | --- | --- |
| T1 输入分片器 + 租约续期 | `src/engine/adaptive/sharder.ts`；`batch-executor.ts` 续期接入 | 9 |
| T2 上下文三层 | `src/engine/adaptive/context-layers.ts` | 9 |
| T3 AdaptiveScheduler | `src/engine/adaptive/adaptive-scheduler.ts` | （与 T4 合并 14） |
| T4 ModelPool 自适应 | `src/engine/adaptive/adaptive-model-pool.ts` | 14 |
| T5 mode 策略执行器 | `src/engine/adaptive/mode-policy.ts` | （与 T6 合并 7） |
| T6 Benchmark | `tests/adaptive/m4-benchmark.mts`、`dev-docs/benchmark/m4-adaptive-benchmark.json` | 11 |

合计 **39 条 M4 断言 + 11 条 Benchmark 全 PASS**；engine 206 / contract 87 零回归。

## 二、量化验收指标

| 指标 | 目标 | 实测 |
| --- | --- | --- |
| 分片确定性 | 同输入同分片 100% | ✅ `stats.deterministic` 两次运行一致 |
| 分片完整性 | 无遗漏无重复 | ✅ 48 项 → 6 片，缺失 0 / 重复 0 |
| 重复上下文 token 降低 | ≥30% | ✅ **100%**（48 任务共享 50KB：引用替代内联） |
| 证据覆盖率不下降 | 不下降 | ✅ `evidenceCoverage=1`（摘要不得替代原文，注册时强制校验） |
| 自适应调度 | 墙钟不劣于静态 | ✅ 长任务先发（59min 任务排前，压缩尾部等待） |
| M4 不依赖 M5 | 仅用 M2/M3 数据 | ✅ `samplesFromCheckpoints` 直接读 M3 checkpoint |
| 质量不降级 | Required 全量执行 | ✅ fast/balanced/quality 三模式 Required 均 3 项全执行；`checkValidationNotWeakened` 无违规 |
| ModelPool 自适应 | 429 降档 / 恢复 | ✅ 16→8（429），连续 3 次成功后 8→9 |

## 三、核心设计

### 三层上下文（关键：减少重复 ≠ 减少信息）

| 层 | 内容 | 传递 |
| --- | --- | --- |
| Shared Context | 所有任务共有的基础信息 | 公共**引用**（+ 导航摘要） |
| Task Context | 每任务独有输入 | 内联 |
| Evidence Reference | 必须保留的原始证据 | 按需读取 |

**强制约束**：`registerShared` 在 `evidence` 为空时**直接抛错**——从 API 层面杜绝"只留摘要丢掉原文"的反模式。证据覆盖率可量化（`validate()`）。

### 自适应调度（依赖修正落实）

数据源严格限定 M2/M3：`samplesFromCheckpoints()` 从 M3 `TaskCheckpoint` 的 `durationMs` 构造画像；样本 <3 时 `confidence<0.5` 自动回落静态调度。**已验证无 M5 基线也能工作**（P0-1 依赖倒置修正的验收）。

### ModelPool 自适应（信号驱动，不猜测）

`429/限流` → 并发减半；`超时/错误` → 同样降档；连续 `recoverAfter` 次成功 → **+1 缓慢回升**（不一次跳回，避免抖动）；`classifyError()` 从错误文本分类。

### Effective Validation

`Effective = Required(Definition 强制) ∪ Profile(追加)`，去重保序；`checkValidationNotWeakened()` 提供不变量检查（供 runtime/CI 守护）。

## 四、M3 遗留问题修复

| M3 遗留 | M4 处置 |
| --- | --- |
| 租约需人工续期（59min 任务会被接管） | ✅ `BatchExecutor` 按 `leaseMs/3` 周期**自动续期**（timer unref，成功/失败均清理） |
| Executor 与分片未接线 | ✅ `planShardedTasks()` 直接产出 `BatchTask` 清单（Benchmark 端到端验证） |

## 五、已知限制

1. **AdaptiveScheduler 尚未自动接入 runtime 的 parallel 调度**：目前是独立规划器（`planSchedule` 产顺序），需调用方按顺序发起。自动接管 `parallel()` 的波次排序留待 M5 与 Evaluator 一起做（需要真实运行反馈闭环）。
2. **tier 建议未强制**：`suggestTier()` 只输出建议，实际模型选择仍由 Plan `modelPolicy` / 脚本 `model`/`tier` 决定（保持确定性优先）。
3. **MCP 直调池未纳入自适应调度**：`mcp-client-pool.ts` 的调用仍是串行/调用方控制。

## 六、下一步（M5 Continuous Optimization）

M5 需要的 M1-M4 基础全部就绪：
- M1：Analyzer 建议（`expectedImpact` 待 Benchmark）
- M2：预算与运行指标（真实 usage）
- M3：任务级耗时与恢复记录
- M4：画像是 M5 正式基线的输入

M5 任务：Evaluator（estimated vs actual 偏差）→ 性能基线（P50/P90/回归检测）→ 优化建议质量回评 → 基准常态化（复用 schedule）→ 优化闭环工作流（含授权闸门）。
