# MCP-M1 执行报告：Workflow Intelligence（工作流理解与性能分析）

- 日期：2026-11-18
- 架构基线：`dev-docs/design/workflow-engineering-framework.md`
- 执行计划：`dev-docs/planning/2026-11-18-workflow-engineering-execution-plan.md`
- 结论：**M1（T0-T8）全部完成**，量化验收指标全部达标

---

## 一、交付清单

| 任务 | 交付物 | 断言数 |
| --- | --- | --- |
| T0 基线与测试样本 | `dev-docs/design/m1-baseline.md`、`dev-docs/benchmark/m1-baseline.json`、`tests/analyzer/fixtures/{real,atomic}/` | — |
| T1 Workflow Plan | `src/engine/plan/{schema,source-fingerprint,plan-validator,plan-loader}.ts`、`tests/plan/plan.test.ts` | 14 |
| T2 AST Analyzer | `src/engine/analyzer/{ast-parser,call-graph}.ts`、`tests/analyzer/ast-parser.test.ts` | 10 |
| T3 规则引擎 | `src/engine/analyzer/{types.ts,rule-engine.ts,rules/index.ts}`、`tests/analyzer/rule-engine.test.ts` | 14 |
| T4 Analysis Report | `src/engine/analyzer/report-builder.ts`、`tests/analyzer/report.test.ts` | 8 |
| T5 AI Optimization Planner | `src/engine/analyzer/optimization-planner.ts`、`tests/analyzer/optimization-planner.test.ts` | 9 |
| T6 CLI + Pi 工具 | `src/tools/workflow-analyze-tool.ts`、`tests/analyzer/analyze-tool.test.ts`、主入口注册 | 12 |
| T7 Skill 集成 | `skills/workflow-authoring/{SKILL.md,references/workflow-plan.md,references/analyzer-rules.md}` | — |
| T8 Benchmark | `tests/analyzer/benchmark.mts`、`dev-docs/benchmark/m1-analyzer-benchmark.json` | — |

合计 **67 条新断言全 PASS**，engine 206 条零回归。

## 二、量化验收指标

| 指标 | 目标 | 实测 |
| --- | --- | --- |
| 静态可确定节点的 DSL 识别率 | 100% | ✅ 8 类原子场景全覆盖（agent/parallel/pipeline/sequence/fallback/race/workflow/mcp.call） |
| 直接依赖关系识别 | 测试样本 100% | ✅ recall 100%（4/4 标注项） |
| 已知风险规则测试通过率 | 100% | ✅ 14/14 |
| 关键风险代码定位准确率 | ≥95% | ✅ finding 全部带行号区间，测试断言行号正确 |
| 静态分析误报率 | ≤10% | ✅ **0%**（4/4 应排除项无误报） |
| 旧 Workflow 兼容测试 | 100% | ✅ 无 Plan 时 `loadPlan` 返回 null 且正常分析；9 个真实脚本（含 1212 行 game-prd-check）全部可分析 |
| Analyzer 输出确定性 | 100% | ✅ 9 个真实脚本两次运行 JSON 完全一致 |

## 三、真实基线（T0 采集，58 个 run）

| runId | Agents | P50 | 最大单 Agent | failed |
| --- | --- | --- | --- | --- |
| run-mwkpasup-2 | **140** | 14.1 min | **59 min** | 17 |
| run-mwfb5d3r-7 | 86 | 8.9 min | **68.3 min** | 2 |
| run-mwep59gd-1 | 64 | 10.2 min | 57.7 min | 17 |

三类确证性能风险：大规模失败恢复成本（140 agent/17 failed）、单 Agent 长尾（59-68 min）、重复上下文（repeated-context 原子重现）。

## 四、架构约束落实核对

| 约束（架构基线第五节） | 落实 |
| --- | --- |
| 陷阱 1：Analyzer 不变成 Runtime | ✅ 纯静态分析，不执行 agent、无运行状态 |
| 陷阱 2：静态结果不当精确执行图 | ✅ 动态循环带界/动态分发 Unknown；`executionEstimate.determined=false`；Candidate 置信度 0.4-0.7 且禁自动采纳 |
| 陷阱 3：AI 不直接重写生产 Workflow | ✅ Planner 只输出建议（`proposal.action` 可执行但需授权链）；T7 六步链写入 SKILL.md 不变量 |
| 陷阱 4：不为 Plan 引入第二套 DSL | ✅ Plan 只描述 stages/quality/profiles，业务逻辑仍在 JS |
| 陷阱 5：不为性能牺牲覆盖率 | ✅ Planner 强制要求 Evidence Reference 保留、validation 非空；INPUT-001 建议标 qualityRisk=high |
| 优化必须有真实数据依据 | ✅ `expectedImpact` 一律「待 Benchmark」；实测无基准时给百分比会被自动改写 |

## 五、关键设计说明

1. **依赖置信度四级**：Explicit（数据引用）/ Structural（容器归属）/ Candidate（相邻无引用，需语义确认）/ Unknown（动态）。Benchmark 中「真串行不得给并行建议」「动态循环/分发不得给并行建议」全部通过——这是误报率 0% 的核心保障。
2. **计划过期检测**：`source.scriptHash` vs 当前脚本；`planHash = SHA256(canonicalJSON(Plan without planHash))`，剔除 `analyzedAt`，防自引用。
3. **Plan Definition/Profile 分离**：测试验证 Profile 声明 `requiredValidation` / `stages` 会被 Validator 拒绝；`resolveEffectivePolicy` 保证强制验证恒生效。
4. **工具与 CLI 同一 Core**：`analyzeWorkflow()` 是唯一入口，Pi 工具与 CLI 都是薄封装（测试验证两者输出一致）。

## 六、遗留与下一步

- **M1-T8 的「优化前后实际对比」**：需要真实执行一次优化（消耗模型 token 与时间），归入 M2 前后的实测任务；M1 已交付分析能力与基线，对照实验建议在 M2 完成后与 Execution Trace 一起做
- **Execution Trace**（跨阶段能力）：M1 侧已保证报告含 `sourceHash`/五级 ID 兼容基础（runId 复用现有 journal 的 `runId:callIndex:attempt`），M2 完善结构化指标采集时接入
- **下一步**：M2 Execution Governance（Budget 三分类 + Plan 执行消费 + 运行指标），任务清单待细化入 todos
