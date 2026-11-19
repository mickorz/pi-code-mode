# AI Rule Checker 执行报告（P0 + P1）

- 日期：2026-11-19
- 计划来源：`dev-docs/planning/2026-11-19-game-requirement-audit-analysis-upgrade-execution-plan.md`
- 范围：P0（统一聚合口径）+ P1（AI Rule Checker 默认开启）
- 结论：**P0、P1 已完成并在真实脚本上通过验收**；P2（REC-002/IO-001 跨文件静态规则）未实施，原因见第五节

---

## 一、P0：统一聚合口径（已完成）

### 问题

同一次分析出现两套数字：

| 输出 | 结果 |
| --- | --- |
| Dashboard | 23 条 finding、`CONC-002×2` / `SERIAL-002×9` / `RETRY-001×13` |
| Markdown | 1 条 finding、`CONC-002 通过` / `SERIAL-002 通过` / `RETRY-001 命中 1` |

根因：Dashboard 在渲染阶段自行合并子树，Markdown 消费入口口径的 `report.ruleInventory`。

### 改动

| 文件 | 改动 |
| --- | --- |
| `src/engine/analyzer/report-builder.ts` | `AnalysisReport` 新增 `entry`（入口明细）、`aggregateRiskScore`（最危险单文件）；Markdown 头部显示三组数字 |
| `src/tools/workflow-analyze-tool.ts` | 聚合后把顶层 `findings` / `ruleInventory` / `summary` 改为 **aggregate** 口径 |
| `src/engine/analyzer/dashboard/build-dashboard.ts` | 删除二次合并（否则双倍计数），直接消费顶层 |

### 验收（真实脚本）

```
入口风险分: 2/100
聚合风险分: 7/100（取最危险单文件，不求和）
分析范围: 12 个文件 / 40 调用点 / 最危险 game-requirement-audit/1-scan-template.js
问题口径: 入口 1 条 + 子 workflow 22 条 = 聚合 23 条
```

counts：11 medium + 12 low = 23；规则命中 `CONC-002×2` / `SERIAL-002×9` / `RETRY-001×13`，Markdown 与 Dashboard **完全一致**。

---

## 二、P1：AI Rule Checker（已完成）

### 与 Planner 的本质区别

| | Planner（原有） | Rule Checker（新增） |
| --- | --- | --- |
| 输入 | 静态 finding 摘要 | **9 份 rule.md + 源码上下文** |
| 任务 | 针对已有 finding 给建议 | **按规则文档独立判定** pass/hit/uncertain |
| 能否发现静态漏报 | **不能**（prompt 明确禁止重新分析） | **能**（这是升级目的） |

### 新增模块 `src/engine/analyzer/ai-rule-checker/`

| 文件 | 职责 |
| --- | --- |
| `types.ts` | `AIRuleCheck` / `AIRuleCheckResult` / `MergedRuleResult` 契约 |
| `rule-doc-loader.ts` | 加载 `definitions/NN-<ID>-rule.md`；缺文档显式报错不静默 |
| `prompt-builder.ts` | 构造检查 prompt；`condenseRuleDoc()` 裁剪规则文档；`buildSourceContext()` 只给关键行窗口 |
| `evidence-validator.ts` | 证据校验（文件后缀匹配、行号范围、quote 逐字核对） |
| `ai-rule-checker.ts` | 分组执行 + 并发闸门 + JSON 解析 + 失败降级 |
| `result-merger.ts` | 静态 × AI 合并；AI 不能推翻静态结构事实 |

### 三条防幻觉机制（都有测试）

1. **引文必须逐字存在**：编造 quote 直接丢弃；越界行号丢弃；文件不在集合内丢弃
2. **无证据不成立**：`hit` 但证据全被丢弃 → 降级 `uncertain`
3. **AI 不能覆盖静态事实**：静态 `hit` + AI `pass` → `conflict`（标人工复核），不是覆盖

### 合并语义

| 静态 | AI | 最终 | 含义 |
| --- | --- | --- | --- |
| hit | hit | `both` | 两侧一致 |
| hit | pass | `conflict` | 结构事实优先，标人工复核 |
| pass | hit | `ai-hit` | **AI 补上静态看不见的问题（核心增量）** |
| pass | uncertain | `uncertain` | 需人工确认，不计入风险分 |

### 真实场景结果（game-requirement-audit.js）

```
静态分析: 85ms
AI Rule Check: 291s / status=completed / 9 条规则全部出结论

INPUT-001    pass  0.80
CONC-001     pass  0.90
CONC-002     uncertain 0.40  → conflict（静态命中 2 处，结构事实优先）
SERIAL-001   pass  0.90
SERIAL-002   hit   0.70      → both
TIMEOUT-001  pass  0.95
RETRY-001    hit   0.90      → both
DET-001      pass  0.90
REC-001      pass  0.90
```

### AI 实际发现的静态规则看不到的细节

`SERIAL-002` 的 AI 分析给出：

> 4 组共 9 个 `agent()` 调用源码相邻且 `referencedIdentifiers` 无交集……风险说明：
> **4-client-verify 组内含动态节点 call-6**（位于 `if (fileList.files.length === 0)` 分支，引用 call-5 结果 fileList）——组内置信度下调至 0.40；
> **1-scan-template 组 call-2 的入参 scanText 由 call-1 结果 scan 序列化而来**，存在隐含数据顺序；
> **10-unified-spec 两组调用之间夹着确定性闸门 commandSuccess**（check-planner-leak / build-stage-manifest）

这些是纯静态正则无法得出的跨调用语义结论。

`CONC-002` 的 AI 分析指出 `structure` 来自 `:58 const structure = await agent(` 的回读结果——即分片数取决于模型输出，属运行时不可知。静态规则只能说"集合不可知"，AI 能说清**为什么**不可知。

---

## 三、Exec 调优过程（实测记录）

AI 检查在真实脚本上经过 5 轮调优：

| 轮次 | 分组方式 | 结果 |
| --- | --- | --- |
| 1 | 2 组（5+4 条规则） | 语义组 300s 无返回 |
| 2 | 3 组（3+4+2） | 含 4 条规则的组仍超时 |
| 3 | 4 组（2~3 条） | 仍有组随机超时（模型端波动） |
| 4 | 1 条/组 + 裁剪规则文档代码块 | 8/9 成功，仅 SERIAL-002 超时 |
| 5 | 同上 + 默认 240s + 两阶段 | **9/9 成功，291s** |

关键发现：

1. **规则文档里的围栏代码块是主要负担**。去掉后（`condenseRuleDoc`）超时从 3 条降到 1 条。AI 有真实源码上下文，不需要规则文档里的正例/反例。
2. **单条规则一次调用比多规则合并更稳**。9 次小调用（每次 1 份文档 + 精简窗口）总耗时 291s，优于 2 组大调用（超时）。
3. **AI Rule Check 必须与静态分析分阶段**。否则用户要等 5 分钟才看到第一个字。现改为：静态 85ms 先出报告与 Dashboard，AI 完成后覆盖同一份文件。

---

## 四、Dashboard 升级

规则检查 Tab 从 4 列扩为 6 列：

| 规则 | 严重度 | 静态 | AI 复核 | 最终 | 检查项 |
| --- | --- | --- | --- | --- | --- |
| `CONC-002` | medium | 命中 2 | 待确认 0.40 | `conflict` | …（附「静态命中 2 处，AI 判定 uncertain（结构事实优先，请人工复核 AI 结论）」） |
| `SERIAL-002` | medium | 命中 9 | hit 0.70 | `both` | … |
| `RETRY-001` | low | 命中 13 | hit 0.90 | `both` | … |

下方新增 **AI Rule Check 区块**：状态、耗时、逐条结论、`reason`、证据（文件 + 行号 + quote）。

产物：`.pi/workflows/reports/dashboard/game-requirement-audit分析-Dashboard-20261119-02.html`（47 KB）

---

## 五、P2 未实施的原因

计划中 P2 包含 `REC-002`（retry 影响集合传递）、`IO-001`（确定性 IO 代理）、`BUDGET-001`、`INPUT-002`、`SIDEFX-001`。

未实施原因：

1. **本次升级的核心目标已达成**：`anal` 现在默认执行真正的 AI 规则检查，且能在报告中区分静态/AI/冲突/待确认。
2. **P2 是新增静态规则，需要跨函数数据流追踪**（如 `impact.impactSet` → `runStage()` 参数），当前 `runRules()` 只做单文件局部 AST。这属于独立的引擎能力，不适合塞进本次 P1 收尾。
3. **优先验证已有能力**：SERIAL-002 的 AI 分析已证明模型能做跨文件语义推断；先把这条路径跑稳，比再加 5 条静态规则更有价值。

建议下一步：把 `REC-002` 作为**首个 AI 规则**实现——它的判定依据是 rule.md + 源码，不需要新增 AST 数据流分析，正好验证 AI Rule Checker 能否发现人工审计级别的跨文件缺陷。

---

## 六、测试

| 套件 | 结果 |
| --- | --- |
| analyzer | **98/98**（新增 ai-rule-checker 16 用例） |
| contract | **123/123** |
| engine | 206/206（未受影响） |

关键守卫（`tests/analyzer/ai-rule-checker.test.ts`）：

- 编造引文必须被丢弃并降级 uncertain
- 越界行号 / 文件不在集合内必须被丢弃
- 真实引文必须保留
- 低置信度强制降级
- 静态 hit + AI pass 必须是 conflict（不能覆盖）
- 静态 pass + AI hit 必须是 ai-hit
- 单条规则失败不影响其它规则（partial）
- 无规则文档时 skipped 而非静默通过
- 模型输出不可解析时该规则记 error

`tests/contract/analyze-command.test.ts` 全部加 `--no-rule-check`——契约测试禁止触发真实模型调用。

---

## 七、已知限制

1. **AI Rule Check 耗时 290s 左右**（9 条规则 × 单条调用，并发 3）。这是 zhipu `glm-5.3-flash`（reasoning 模型）的固有速度。
2. **单条规则仍可能超时**。实测 5 轮里 SERIAL-002 有 2 次超时。超时后该规则记 `error`、`finalStatus` 回落到静态结论，报告明确标注——不会伪装成"通过"。
3. **AI 结论不进入 `findings` 列表**，只体现在 `ruleMerge` 与规则页。若需 AI 发现的具体问题出现在问题列表，需在 `ai-hit` 时额外生成 finding（下一步）。
4. **证据只能校验引文真实存在**，不能校验"引文是否足以支撑该结论"。这仍需要人工或下游验证。

---

## 引用

- 计划：`dev-docs/planning/2026-11-19-game-requirement-audit-analysis-upgrade-execution-plan.md`
- 差距分析：`dev-docs/troubleshooting/2026-11-19-analysis-dashboard-vs-manual-audit-gap.md`
- 人工审计：`dev-docs/troubleshooting/2026-11-19-game-requirement-audit-workflow-analysis.md`
- 实现：`src/engine/analyzer/ai-rule-checker/`
- 规则文档：`src/engine/analyzer/rules/definitions/`
- 测试：`tests/analyzer/ai-rule-checker.test.ts`、`tests/analyzer/dashboard.test.ts`
- 产物：`.pi/workflows/reports/dashboard/game-requirement-audit分析-Dashboard-20261119-02.html`
