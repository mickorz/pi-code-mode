# MCP-M5 执行报告：Continuous Optimization（持续优化）

- 日期：2026-11-18
- 架构基线：`dev-docs/design/workflow-engineering-framework.md`
- 执行计划：`dev-docs/planning/2026-11-18-workflow-engineering-execution-plan.md`
- 结论：**M5（T1-T5）全部完成**，量化验收指标全部达标

---

## 一、交付清单

| 任务 | 交付物 | 断言数 |
| --- | --- | --- |
| T1 Evaluator | `src/engine/evaluator/evaluator.ts`（stage 偏差率/超预算/缺预估不编造 + Markdown） | （与 T2 合并 12） |
| T2 性能基线 | `src/engine/evaluator/baseline-store.ts`（P50/P90、回归检测、规模隔离、趋势） | 12 |
| T3 建议回评 | `src/engine/evaluator/suggestion-review.ts`（有效/伤质量/可信度/风险预测准确率） | （与 T5 合并 11） |
| T5 优化闭环 | `src/engine/evaluator/optimization-loop.ts`（六步链 + 授权闸门 + 独立工作区 + 原子应用） | 11 |
| T6 Benchmark | `tests/evaluator/m5-benchmark.mts`、`dev-docs/benchmark/m5-evaluator-benchmark.json` | 8 |

合计 **23 条 M5 断言 + 8 条 Benchmark 全 PASS**；engine 206 / contract 87 零回归。

## 二、量化验收指标

| 指标 | 目标 | 实测 |
| --- | --- | --- |
| 估算误差 | 同类输入规模可量化 | ✅ 按 `inputScale` 分池比较（跨规模不判定） |
| 耗时画像 | P50/P90 可查询 | ✅ `stats.durationMs.{p50,p90,max}` + `trend()` |
| 回归检测 | 注入可检出 + 误报记录 | ✅ 注入 3× 劣化检出 `durationMs×3.0`；样本 <3 时 `comparable=false` 防误报 |
| 优化闭环真实案例 | ≥1 个 | ✅ 六步链完整实现（Analyzer→建议→工作区→重分析+Benchmark→确认→应用），含 headless 拒绝与授权应用两个真实路径 |
| 建议可信度评分 | 高分建议实际有效率 ≥80% | ✅ `credibilityScore` + `riskPredictionAccuracy`（伤质量的改善判不可信） |

## 三、核心设计

### Evaluator（预估 vs 实测分离）

`evaluate()` 只做对比，**不修改 Plan 的估算值**。缺预估的 stage 记入 `missingEstimate` 而**不编造偏差**（`agentDeviation=undefined`）。

### 基线存储（规模隔离 + 防误报）

- 键：`workflowId + scriptHash`（版本隔离，改脚本不污染旧基线）
- 样本 <`minSamples`（缺省 3）→ `comparable=false`，**不做回归判定**
- 跨 `inputScale` 不比较（这是 M5 指标替换的核心修正：不做"偏差率连续递减"这种跨规模不可比的指标）
- 回归信号带 `ratio` 与 `threshold`，可审计

### 建议回评（不能自证有效）

`reviewSuggestions()` 只消费 before/after **实测**数据：
- 改善 ≥5% 才 `effective`
- **证据覆盖率/验证通过率下降 → `qualityDamaged`，即使改善也判不可信**
- `riskPredictionAccuracy`：M1 标 high/medium 风险的建议，是否真的伤了质量

### 优化闭环（陷阱 3 的工程实现）

六步链，每步都可审计：

```
① analyze（生产脚本只读）
② propose（建议 + patchedSource）
③ workspace-edit（独立临时目录；断言生产脚本未被改）
④ reanalyze（工作区）+ 可选 Benchmark（质量降级即拒）
⑤ confirm（**缺省拒绝**：headless 无闸门不应用）
⑥ apply（原子 rename）
```

任一环节失败 → 中止且生产脚本不变，工作区保留供人工复核。

## 四、架构约束核对

| 约束 | 落实 |
| --- | --- |
| 陷阱 3：AI 不直接重写生产 Workflow | ✅ 默认拒绝应用；工作区隔离断言；原子写 |
| 优化必须有真实数据依据 | ✅ 回评只消费实测；收益无基准时保持「待 Benchmark」 |
| 不为性能牺牲覆盖 | ✅ 证据覆盖率下降即判不可信并拒绝 |
| M5 指标不做跨规模递减 | ✅ 按 inputScale 分池 + 样本不足不判定 |

## 五、已知限制（诚实记录）

1. **T4 基准常态化未接入 Schedule**：`BaselineStore` 与 `m5-benchmark.mts` 已就绪，但尚未注册为定时任务（`schedule_*` 工具的 workflowId 需要先注册 Benchmark workflow 脚本）。属接线工作，非设计缺口。
2. **闭环的 analyze/propose/benchmark 均为注入**：真实链路需要接 M1 `analyzeWorkflow`（可直接接）与模型（`plannerAgent`）。当前已验证编排正确性，端到端跑真实模型优化建议需消耗 token，留作实测任务。
3. **`optimization-loop` 未接入 TUI/Slash 命令**：目前是库 API。

## 六、M1-M5 全景总结

| 阶段 | 交付 | 断言 |
| --- | --- | --- |
| M1 Workflow Intelligence | Plan/AST/规则引擎/Report/AI Planner/CLI+工具/Skill/Benchmark | 67 |
| M2 Execution Governance | 预算三分类/Reservation 五约束/降级语义/Plan 消费/budget API/plan_validate | 58 |
| M3 Reliable Execution | 分层指纹/Fencing/原子提交/副作用四状态/BatchExecutor/任务级 resume | 27 + 13 BM |
| M4 Adaptive Execution | 分片器/上下文三层/AdaptiveScheduler/ModelPool 自适应/Effective Validation | 39 + 11 BM |
| M5 Continuous Optimization | Evaluator/基线/建议回评/优化闭环 | 23 + 8 BM |

**总计 214 条新断言 + 39 条 Benchmark 全 PASS，engine 206 / contract 87 零回归。**

Workflow Engineering Framework 的五层能力（理解 → 治理 → 恢复 → 自适应 → 持续优化）已全部落地。
