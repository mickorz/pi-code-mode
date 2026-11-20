# M1 基线报告（T0 交付）

- 日期：2026-11-18
- 数据来源：PrdGameSkill 仓库（`E:/WorkProjects/PrdGameSkill`）`.opencode-workflows/journal/`（58 个 run）与 `workflows/`（真实脚本）
- 提取脚本：`dev-examples/sample-project-acceptance/m1-baseline/extract-journal.mjs`
- 数据落盘：`dev-examples/sample-project-acceptance/m1-baseline/journal-data.json`
- 测试样本：`tests/analyzer/fixtures/real/`（9 个真实脚本，5476 行）、`tests/analyzer/fixtures/atomic/`（7 个原子用例）

---

## 一、真实执行基线（58 个 run 的量化事实）

### 最大规模 run（按 Agent 数排序 Top 6）

| runId | Agents | P50 耗时 | 最大单 Agent 耗时 | failed | 最慢 Agent |
| --- | --- | --- | --- | --- | --- |
| run-mwkpasup-2 | **140** | 14.1 min | **59 min** | 17 | 写阶段规格 ST-C10 |
| run-mwfb5d3r-7 | 86 | 8.9 min | **68.3 min** | 2 | 查证 ST-C07 自摸、放铳、抢杠胡 |
| run-mwep59gd-1 | 64 | 10.2 min | 57.7 min | 17 | 查证 ST-C10 吃碰禁手 |
| run-mwc4mskn-2 | 50 | 13.4 min | 38.3 min | 4 | 提取 托管与超时 |
| run-mwczawsy-1 | 50 | 10 min | 26.9 min | 0 | 检查 房间配置 |
| run-mwdinyo0 | 50 | 8.3 min | 46.5 min | 2 | 检查 对局 |

单 Agent 耗时中位数普遍在 **8-14 分钟**，最大 **59-68 分钟**——单 Agent 即为主要耗时来源，且规模达 140 Agent 的 run 已出现 **17 个失败**（失败恢复成本 = 本框架 M3 的直接动机）。

### 已确认的性能风险（真实样本中可重现的三类）

1. **大规模失败恢复成本**：140 Agent / 17 failed（run-mwkpasup-2）——M3 TaskRegistry + TaskCheckpoint 的直接依据
2. **单 Agent 长尾**：59-68 分钟的 Agent 决定阶段墙钟（并行波次的短板效应）——M4 AdaptiveScheduler + 耗时画像的依据
3. **重复上下文疑似存在**：规则/需求类检查 Agent 大量并行出现（"检查 XX"模式），是否符合 Evidence Reference 分层待 Analyzer 确认——M4 三层上下文的验证场景

## 二、测试样本

### 真实样本（tests/analyzer/fixtures/real/，5476 行）

`8-difference-review.js`、`10-unified-spec.js`、`game-prd-check.js`（1212 行）、`game-requirement-audit.js`（714 行）、`4-client-verify.js`、`5-server-verify.js`、`3-produce-outputs.js`、`bug-coverage-check.js`、`full-check-suite.js`

### 原子测试集（tests/analyzer/fixtures/atomic/，7 个）

| fixture | 覆盖场景 | 期望 Analyzer 输出 |
| --- | --- | --- |
| serial-dependent.js | Explicit 串行链 | 依赖边 Explicit；不建议并行 |
| serial-candidate.js | 无引用顺序调用 | 依赖 Candidate；并行候选建议 |
| dynamic-loop.js | 动态循环 | 动态节点 Unknown（上下界无法确定不估算） |
| dynamic-dispatch.js | 动态分发 | Unknown |
| repeated-context.js | INPUT-001 | HIGH 重复上下文 finding |
| parallel-waves.js | CONC-001 | 48 任务 / 并发 16 / 3 波次 |
| sub-workflow.js | workflow 子流程 | 调用节点识别 |

## 三、T0 验收自查

- [x] 真实 Workflow 样本入库（9 个，含 S8/S10）
- [x] Journal 执行数据还原（58 run → journal-data.json）
- [x] 原子测试集七类
- [x] 优化前基线含失败与长尾数据（质量指标：acceptanceCriteria 引用 PrdGameSkill 各脚本内验证节点，M1-T8 对照时提取）
- [x] 三种性能风险可重现：大规模失败恢复 / 单 Agent 长尾 / 重复上下文（repeated-context.js 原子重现）

## 四、对后续任务的输入

- T2 AST Analyzer：fixtures/real + atomic 为测试集；真实脚本含 `mcp.call`/`tools.mcp__*` 直调与动态循环，T2 需覆盖（对照 M1-T2 动态边界规则）
- T3 规则引擎：上表三类风险为首批规则的验收目标
- T8 Benchmark：C 组优化对照以 run-mwkpasup-2 形态（大 run + 失败恢复）为场景
