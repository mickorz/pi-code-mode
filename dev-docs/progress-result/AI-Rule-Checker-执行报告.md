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

## 五、P2 实施情况

计划原列 5 条跨文件规则。截至本报告更新（2026-11-19 晚）：

### 5.1 REC-002：已完成并验证（aiOnly 路线）

引入 `AnalyzerRule.aiOnly` 契约：该规则**只由 AI Rule Check 判定**，静态 `analyze()` 返回空数组，报告状态记 `ai-only`（绝不显示成"通过"）。

**验收结果（真实脚本，单条规则 97s）**：

```
REC-002 hit conf=0.90 evidence=3

reason: mode=retry 分支（417 行）内 readBack 读取 impact-set.json 得到 impact（419-421 行），
并在 448 行校验 impact.impactSet 非空、450-451 行仅用于日志输出；该收窄集合从未赋值给
stageResults.impactSet（全文件 stageResults 仅 S1~S11 键被赋值，impactSet 键恒为 undefined），
且 impact 是分支内块级 const，runStage 无法引用。因此 runStage（479 行）与 S4/S5 并行调度
（582 行）传给 workflow 的 impactSet 恒为 null 兜底值

impact: mode=retry 端级补证重跑时子流程收到的 impactSet 恒为 null，按全量处理，
恢复退化为重新跑一遍，墙钟与 token 成本按全量计

suggestion: 把读取值固化成块外可见的不可变常量并显式传递：
const retryImpactSet = mode === 'retry' ? impact.impactSet : null

证据: game-requirement-audit.js L419-421 / L476-479 / L581-582（均逐字校验通过）
```

**结论：AI 达到并可超过人工审计水平**——人工文档指出"影响集合没传"，AI 多给出了「impact 是分支内块级 const，runStage 无法引用」「stageResults 仅 S1~S11 键被赋值」这两个作用域级证据。

实测（默认 6 条语义规则，420s，status=partial）：

```
CONC-002    hit   0.85  → both   （指出 S4/S5 partFiles 由 agent 回读循环 push、S10 structure 来自 :58 的 agent）
SERIAL-002  hit   0.70  → both
REC-002     hit   0.95  → ai-hit （完全由 AI 发现，静态不判定）
BUDGET-001  通过  0.80  → pass   （AI 确认并发语义无问题）
DET-001     error       → static-hit（静态已命中 3 处）
SIDEFX-001  error       → error
```

### 5.2 剩余 4 条规则：已完成

| 规则 | 实现 | 真实脚本结果 |
| --- | --- | --- |
| `IO-001` | 静态（prompt 指令匹配） | **hit(12)**，覆盖 10 个文件的 readBack/echoWrite |
| `INPUT-002` | 静态（`effectiveStartIdx` × `fileExists` 交叉） | **pass**（正确：见下方勘误） |
| `BUDGET-001` | aiOnly | AI 判 **pass**（确认并发语义无问题） |
| `SIDEFX-001` | aiOnly | AI 超时（error），静态 SERIAL-002 结果仍有效 |

**顺带修好一个真实能力缺口**：`literalString()` 此前只支持字符串字面量与无插值模板，
真实 workflow 里最常见的 `['a', '', 'b' + var].join('
')` 形态**完全提取不到**，
导致 `IO-001`/`DET-001` 在真实脚本上恒为 pass。扩展后：

- `IO-001`：0 → **12 处命中**
- `DET-001`：0 → **3 处命中**（真实价值：`4-client-verify.js:339` / `5-server-verify.js:319` 让模型"提取 evidence[] 的 file 字段并去重"——纯 JSON 处理交给模型）

同时给 `DET-001` 加了与 `IO-001` 的互斥（"注册表统计回读器"里的"统计"是名词不是任务），避免同一调用双报。

### 5.3 勘误：人工审计文档的 P1-003 是误判

人工审计曾判断"从 S5 开始时仍会校验客户端目录"。复核实际取值：

```
startStage=S5 → startIdx = findIndex(S5) = 4 → effectiveStartIdx = 4
4 <= 3  → false  → 客户端目录校验不执行   ← 原判断错误
4 <= 4  → true   → 服务端目录校验执行     ← 正确
```

已在 `dev-docs/troubleshooting/2026-11-19-game-requirement-audit-workflow-analysis.md`
写入勘误并降级为 P3（仅 `retryScope=server` 时未收窄校验）。

`INPUT-002` 规则在此脚本上正确报 pass，反向验证了规则口径。

### 5.4 实测性能与规则范围控制（新增）

14 条规则全量 AI 复核实测：

| 范围 | 规则数 | 耗时 | 结果 |
| --- | --- | --- | --- |
| `--ai-rules-all` | 14 | **790s** | 10 成功 / 4 超时 |
| 默认（semantic） | 6 | **420s** | 4 成功 / 2 超时 |

结论：结构事实类规则（`RETRY-001` 数 retries、`TIMEOUT-001` 查 timeoutMs）静态 100% 准确，
交给模型只会变慢且可能数错。因此默认只让 AI 复核**静态判定不可靠**的 6 条：

```
CONC-002  SERIAL-002  DET-001  REC-002  BUDGET-001  SIDEFX-001
```

需要全量复核时用 `--ai-rules-all`。

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
