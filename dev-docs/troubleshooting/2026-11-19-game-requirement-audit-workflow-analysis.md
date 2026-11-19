# game-requirement-audit Workflow JS 问题分析报告

- 分析日期：2026-11-19
- 分析对象：`thirdparties/PrdGameSkill/.opencode-workflows/workflows/game-requirement-audit/`
- 分析范围：主编排 `game-requirement-audit.js` + 11 个子 workflow，共 12 个 JS 文件
- 分析方式：
  1. pi-code-mode Analyzer 静态规则扫描
  2. AI Planner 对静态证据做语义复核
  3. 逐文件阅读主编排、阶段切分、并发、重试、超时、恢复与输入校验代码
- 结论：**流程设计完整，但存在 3 个需要优先修复的确定性问题、4 类高成本/高风险结构问题，以及若干需要业务语义确认的优化候选。**

---

## 一、总体结果

| 指标 | 结果 |
| --- | --- |
| 文件数 | 12（入口 + 11 子 workflow） |
| 静态调用点 | 40 |
| 静态 finding | 23 |
| 入口自身 finding | 1 |
| 聚合最高单文件风险 | 7/100，`1-scan-template.js` |
| AI 复核 | 已执行，无诊断错误 |
| 规则命中 | `RETRY-001` ×12、`SERIAL-002` ×9、`CONC-002` ×2 |
| 规则通过 | `INPUT-001`、`CONC-001`、`SERIAL-001`、`TIMEOUT-001`、`DET-001`、`REC-001` 在当前静态口径下未命中 |

> 风险分 2/100 不能理解为“工作流没有问题”。本次风险分只统计置信度达到阈值的静态 finding；`CONC-002` 和部分 `SERIAL-002` 是低置信度语义候选，故不抬高风险分，但仍需要人工确认。

### 1. 按规则分布

| 规则 | 命中数 | 主要文件 | 判断 |
| --- | ---: | --- | --- |
| `RETRY-001` | 12 | 几乎所有含 agent 的阶段 | 确定性成本问题，优先治理 |
| `SERIAL-002` | 9 | S1、S7、S8、S10、S11、S4/S5 收尾 | 并行候选，不能直接改，需确认副作用 |
| `CONC-002` | 2 | S2、S10 | 动态分片并行，需确认分片数、并发、长尾 |

### 2. 按阶段归纳

| 阶段 | 文件 | 主要问题 |
| --- | --- | --- |
| S1 | `1-scan-template.js` | 两个相邻 agent 可能串行；两个调用各允许 retry |
| S2 | `2-atomize-requirements.js` | `stageSections.map` 动态并行；retries=2 |
| S3 | `3-build-registry.js` | retries=2，单 agent 不需要并行 |
| S4 | `4-client-verify.js` | 动态 `partFiles.map`；S4 收尾有并行候选；retries=2；单片最长 2 小时 |
| S5 | `5-server-verify.js` | 与 S4 同构：动态分片、收尾串行候选、retries=2 |
| S6 | `6-merge-evidence.js` | retries=2；汇总阶段本身合理串行 |
| S7 | `7-business-behavior.js` | 准备阶段可能并行；动态分片并行；retries=2 |
| S8 | `8-difference-review.js` | 准备阶段可能并行；动态分片并行；retries=2 |
| S9 | `9-classify-l7.js` | retries=2；单 agent 阶段 |
| S10 | `10-unified-spec.js` | 动态 `structure.stages.map`；策划/统计调用存在串行候选；retries=2 |
| S11 | `11-human-review.js` | 适用性判断/应用决议可能串行候选；retries=2 |
| 入口 | `game-requirement-audit.js` | S4/S5 外层并行 + 子流程内层并行；retry 参数存在传递缺陷；路径与模式校验仍有治理风险 |

---

## 二、P0/P1：应优先修复的确定性问题

### P1-001：retry 模式没有把影响集合传给子 workflow

**位置**：`game-requirement-audit.js`

- `mode === 'retry'` 时，入口会从 `6-review/runtime/impact-set.json` 读出 `impact`。
- 但 `runStage()` 使用的是：

```js
impactSet: stageResults.impactSet || null
```

- `stageResults` 在 retry 分支没有被赋值为 `impact.impactSet`。
- S4/S5 只会收到 `null`，因此 retry 模式可能退化为普通端级重跑，无法严格限制到影响原子集合。

**影响**：

- 用户以为执行的是端级补证，实际可能重新处理更多分片。
- 任务级恢复的成本边界被破坏，增加 token、墙钟和产物覆盖风险。
- retry 的核心承诺“只重跑影响集合”无法仅凭当前代码成立。

**建议**：

```js
const retryImpactSet = mode === 'retry' ? impact.impactSet : null
```

并在 `runStage()` 和 S4/S5 的 `Object.assign` 中显式使用 `retryImpactSet`，不要依赖可变的 `stageResults` 间接传递。

**验收**：

1. 构造包含 client/server 不同影响集合的 `impact-set.json`。
2. 执行 `mode=retry retryScope=client startStage=S4`。
3. 子 workflow 收到的 `impactSet.client` 与文件完全一致，`impactSet.server` 不被执行。
4. journal 能证明未受影响原子没有重新调用 agent。

---

### P1-002：入口聚合与单文件报告的 finding 口径容易产生误判

**位置**：入口报告与子流程聚合链路。

入口自身只有 1 条 finding，但 11 个子流程合计 23 条。若只看 `report.findings`，会得到“只有一个问题”；真正的问题分布在子流程中。

当前 Dashboard 已补充子流程 findings 合并，因此 Dashboard 能展示 23 条；但 Markdown/JSON 的入口 finding 与 `subtree.totalFindings` 仍然是两个层次，使用者如果没有理解聚合口径，仍可能把入口结果误当作全量结果。

**影响**：

- 报告读者可能只修入口文件，遗漏 11 个子 workflow 的实际问题。
- “风险分 2/100”与“聚合 23 条 finding”同时出现时，需要额外解释，否则容易误判。

**建议**：

- Markdown 顶部明确写“入口自身 findings”和“跨文件聚合 findings”两组数字。
- JSON 增加 `scope: entry | subtree`，不要让消费者猜测。
- 规则命中数、严重度统计、问题列表统一使用 subtree 口径；入口自身数据单独保留。

**验收**：

报告中同时可见：入口 1 条、聚合 23 条、12 个文件，并且三者不会被误认为同一统计口径。

---

### P1-003：主入口和子流程的输入校验存在过度要求

**位置**：`game-requirement-audit.js` 输入就位检查。

当前逻辑：

```js
if (effectiveStartIdx <= 3) {
  await check(() => fileExists(codeDir), '客户端代码工程不存在')
  await check(() => fileExists(fguiDir), 'FairyGUI 工程不存在')
}
if (effectiveStartIdx <= 4) {
  await check(() => fileExists(serverSrcRoot), '服务端源码根不存在')
}
```

当从 S5 开始时，`effectiveStartIdx === 4`，仍会要求客户端 `codeDir` 和 `fguiDir` 存在；当只重跑服务端时，这些输入并不是必需的。

**影响**：

- `from-stage startStage=S5` 或 server retry 可能被无关的客户端目录阻断。
- 破坏阶段级恢复的独立性。

**建议**：

- S4 只校验 `codeDir`/`fguiDir`。
- S5 只校验 `serverSrcRoot`。
- `retryScope=client` 与 `retryScope=server` 分别只校验对应输入。

**验收**：

删除客户端目录后，S5 单独重跑仍能启动；删除服务端目录后，S4 单独重跑仍能启动并在正确位置失败。

---

## 三、P1/P2：高成本与结构风险

### P1-004：全阶段统一 `retries: 2`，失败成本被整体放大

**覆盖位置**：1~11 子 workflow 多处 agent 配置；入口 `readBack()` 与 `echoWrite()` 也统一配置 retry。

静态结果：

- 入口 2 个 agent：最坏约 6 次调用。
- S4/S5 各 7 个调用点：单文件最坏约 21 次调用。
- S10 4 个调用点：最坏约 12 次调用。
- 多个阶段将 `retries: 2` 用在文件读取、结构化解析、写盘回读和汇总等不同性质的任务上。

**问题**：

- 确定性错误（schema 不合法、输入路径错误、产物缺失）重试通常不会成功。
- 长耗任务每次最长 3600~7200 秒，重试会把故障窗口放大到小时级。
- 入口 `readBack()` 读取本地文件失败时也会调用模型重试，成本高且诊断慢。

**建议**：

| 调用类型 | 建议 retry |
| --- | ---: |
| 确定性本地文件读取/JSON 解析 | 0 |
| schema 校验失败但可修复的模型输出 | 1，配合明确修复 prompt |
| 网络抖动/限流 | 1~2，必须带退避 |
| 2 小时级 S4/S5 分片 | 0~1，优先任务级恢复 |
| 汇总/写盘类 agent | 0~1 |

不要全局机械替换；先按失败类型分类。

---

### P1-005：动态分片的并发、波次与长尾没有显式治理

**文件**：`2-atomize-requirements.js`、`4-client-verify.js`、`5-server-verify.js`、`7-business-behavior.js`、`8-difference-review.js`、`10-unified-spec.js`。

典型形式：

```js
await parallel(runtimeCollection.map((item) => () => agent(...)))
```

静态无法知道 `runtimeCollection` 的实际长度。尤其：

- S4/S5 的 `partFiles` 动态分片，单次 `timeoutMs: 7200000`。
- 入口又对 S4 与 S5 做外层 `parallel`。
- S2/S10 等阶段也使用运行时集合并行。

**影响**：

- 实际分片数超过并发上限时，波次增加。
- 单片 2 小时会产生明显长尾。
- 入口层 S4∥S5 与子流程内部并行可能造成并发叠加，`concurrency=16` 是否是全局共享配额必须依赖运行时实测，不能仅靠代码假设。
- 失败时整波屏障等待，恢复粒度不足会放大损失。

**建议**：

1. 在运行时日志记录每个动态集合的实际数量、并发上限、波次、最长/平均耗时。
2. S4/S5 明确声明并发预算分配，例如双端各 8，而不是两个子流程都默认争抢 16。
3. 对单片任务设置独立 watchdog，避免 7200 秒任务占住整个波次。
4. 用 TaskCheckpoint 记录每个分片，失败只重跑失败分片。
5. 在 Dashboard/运行报告中区分“静态下限”和“运行时实际数量”。

**验收**：

至少用 3 种分片规模（小于并发、等于并发、大于并发）跑 Benchmark，记录实际波次、墙钟、失败重试数和 token。

---

### P1-006：外层 S4∥S5 与子流程内部并行的资源预算边界不够明确

**位置**：`game-requirement-audit.js` S4/S5 调用；`4-client-verify.js`、`5-server-verify.js` 内部 `parallel`。

入口写明“共享并发配额”，但代码层只把 `concurrency` 传给子流程，并没有在入口明确切分资源预算。若运行时的全局闸门确实跨嵌套 workflow 生效，需要契约测试证明；若只在每个 workflow session 内生效，可能出现双端各自按 16 并发。

**建议**：

- 明确并发语义是全局、run 级还是 workflow 级。
- 如果是全局预算，增加运行时 journal 证据：最大同时在途数不得超过 16。
- 如果不是全局预算，入口显式传 `clientConcurrency`/`serverConcurrency`，并确保总和不超过预算。

---

### P2-001：`readBack` 与 `echoWrite` 把确定性 IO 交给 agent

**位置**：`game-requirement-audit.js` 的 `readBack()`、`echoWrite()`。

入口注释说明 workflow 侧没有 fs，因此用 agent 读取和写入文件。这是当前宿主能力边界下的可理解折中，但它引入：

- 模型耗时与 token 成本。
- 文件读取/写入失败被模型层包装，错误定位变慢。
- `echoWrite` 依赖模型“逐字复制”，存在内容改写、截断或遗漏风险。
- 这类调用不能真正从语义判断中获益，却承担 retry 和 timeout 成本。

**建议**：

- 如果 workflow runtime 可以安全暴露受治理的 `readFile`/`writeFileAtomic`，优先改为确定性工具。
- 在无法改 runtime 前，至少给 echo 写入增加 hash/字节数回读校验。
- `readBack` 读取 JSON 后用 schema 校验；失败时报告原始路径、字节数和 hash。

---

### P2-002：大量阶段使用“同构的准备 agent + 分片 agent + 汇总 agent”，但缺少统一策略抽象

S4/S5、S7/S8 结构高度相似：准备输入 → 动态分片并行 → 汇总。现在每个文件各自维护 timeout、retry、label 和输出协议。

**风险**：

- 客户端与服务端修复容易不一致。
- 一个阶段的 timeout/retry 改动不会自动同步到同构阶段。
- 分片输入、失败重试、产物落盘的契约难以统一验证。

**建议**：

先不要引入复杂工厂；最小方案是把以下内容集中到一个规则/配置表：

- 阶段 ID
- 分片集合字段
- 单片 timeout
- retry 策略
- 输出目录与 schema
- 恢复键

然后让 S4/S5 共用同一份配置校验，不要复制业务逻辑。

---

## 四、需要 AI/人工确认的优化候选

这些不是可以直接改的确定性缺陷，Analyzer 的置信度低于 0.5 或明确标记了 Candidate。

### P2-003：相邻 agent 调用可能可以并行

命中文件：

- `1-scan-template.js`：两个扫描/回读调用
- `7-business-behavior.js`：准备阶段调用
- `8-difference-review.js`：准备阶段调用
- `10-unified-spec.js`：planner 与后续统计/校验调用
- `11-human-review.js`：适用性判断与应用决议
- S4/S5 收尾：分支状态更新、文件清单、证据清单等

**不能直接并行的原因**：

静态 AST 只能看到变量没有直接引用；看不到：

- 是否读写同一文件。
- 是否依赖前一调用的落盘副作用。
- 是否要求前一步先完成后才能让下游扫描到最新文件。
- 是否共享同一 run 状态或锁。

**处理方式**：

逐组记录输入、输出、共享文件和副作用；只有确认独立后才改 `parallel`。改后必须对同一输入做串行/并行产物对比。

---

### P2-004：S4/S5 的双端查证是否真正适合同时运行

入口将客户端查证和服务端查证作为互不依赖的并行阶段，这是合理候选，但二者共享：

- 同一个 runDir
- 共享并发预算
- 可能共享 evidence/manifest 目录结构
- 相同阶段状态和 record-stage 资源

需要确认它们是否写入完全不同的路径，以及 stage-reuse/run-state 是否支持两个并行阶段的状态更新。

**验收**：

- 对 runDir 做写入路径清单。
- 并发运行时检查是否出现同名临时文件、锁竞争、manifest 覆盖。
- 验证 S4 失败不会阻止 S5 正常完成并留下可恢复状态。

---

## 五、设计上合理、不要误修的部分

1. **S6 在 S4/S5 之后串行**：证据汇总依赖双端结果，同步屏障是合理的。
2. **S10/S11 串行**：规格生成与人工裁决有明确阶段依赖，不应因 SERIAL-002 提示就自动并行。
3. **S4/S5 分片使用 `parallel`**：动态分片本身不是错误，问题是需要显式数量、预算、超时和恢复观测。
4. **`phase()` 边界总体完整**：当前 `REC-001` 未命中，说明阶段恢复设计方向正确；不能因为 retries 命中就否定 phase/checkpoint 体系。
5. **低置信度 finding 不抬高风险分**：`CONC-002` 的 0.4 置信度是正确的保守策略，不应把“需要人工确认”直接当成确定缺陷。

---

## 六、建议修复顺序

### 第一批：确定性修复

1. 修复 retry 影响集合传递：`stageResults.impactSet` → 明确的 `retryImpactSet`。
2. 修正阶段输入校验，只校验目标阶段需要的目录。
3. 统一报告 entry/subtree 统计口径，避免 1 条与 23 条并列但没有明确说明。
4. 为 retry 和恢复增加契约测试与 journal 断言。

### 第二批：治理和观测

1. 记录动态分片实际数量、最大并发、波次、长尾和失败重试。
2. 确认嵌套 workflow 的全局并发预算语义。
3. 按调用类型细分 retry，不再所有 agent 固定 `retries: 2`。
4. 为 echoWrite 增加写后 hash/长度校验。

### 第三批：语义优化

1. 人工确认 SERIAL-002 候选组。
2. 对 S4/S5 外层并行做共享目录与锁竞争验证。
3. 仅对确认独立的调用改为 parallel，并做产物一致性 Benchmark。

---

## 七、最终结论

当前 workflow **不是“不能用”**，而是“阶段设计较完整，但成本治理和恢复边界还不够硬”。

最值得先修的是：

- retry 模式影响集合没有可靠传递；
- 动态分片的真实规模与嵌套并发没有运行时证据；
- 统一 `retries: 2` 会把长耗任务和确定性错误的成本放大；
- 入口报告必须始终明确区分自身结果与 12 文件聚合结果。

不建议第一步就把所有 SERIAL-002 改成 `parallel`。这些 finding 只能说明“静态上没有直接数据引用”，不能证明没有文件副作用或业务顺序依赖。

---

## 引用

- 真实入口：`thirdparties/PrdGameSkill/.opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js`
- 子流程目录：`thirdparties/PrdGameSkill/.opencode-workflows/workflows/game-requirement-audit/`
- Analyzer 规则说明：`src/engine/analyzer/rules/definitions/`
- 真实分析产物：`.pi/workflows/reports/game-requirement-audit.analysis.json`
- Dashboard 执行报告：`dev-docs/progress-result/Analysis-Dashboard-执行报告.md`
- 规则文件参考：`thirdparties/PrdGameSkill/.claude/skills/game-prd-check/references/rules/`
