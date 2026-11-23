# Workflow Analysis: E:\WorkProjects\PrdGameSkill\.opencode-workflows\workflows\game-requirement-audit\1-scan-template.js

- analyzer 1.0.0 / ruleSet 1.0.0
- sourceHash: `sha256:182a6f5ba18b708c…`
- 入口风险: **8%**
- 最高单文件风险: **14%**（聚合口径，不求和）
- 分析范围: 12 个文件 / 40 调用点 / 最危险 game-requirement-audit/7-business-behavior.js
- **问题口径: 入口 3 条 + 子 workflow 34 条 = 聚合 37 条**

> **关于「置信度」**：表示这条判断有多可信（0~1 之间，越大越可信）。≥0.85 确定、≥0.7 很可能、≥0.5 待确认（需人工判断）、**<0.5 仅提示（不计入风险分，只作检查线索）**。

## 调用结构

- 调用点: 2（agent 2 / workflow 0）
- 估算任务量: 2

## 检查清单（全部规则都执行过）

| 规则 | 严重度 | 静态 | AI 复核 | 最终 | 检查项 |
| --- | --- | --- | --- | --- | --- |
| `INPUT-001` | high | 通过 | 未启用 | pass | 同一个输入对象被多次注入不同 agent → 重复序列化与 token 浪费 |
| `CONC-001` | medium | 通过 | 未启用 | pass | 并行任务数超过并发上限 → 多波次执行（要求任务数静态可确定） |
| `CONC-002` | medium | 命中 2 | hit（确定） | both | 并行任务数是运行时动态决定的分片（静态不可知，需人工确认分片数/并发/超时） |
| `SERIAL-001` | low | 通过 | 未启用 | pass | 多个 agent 构成明确数据依赖链（合理串行，但可能是墙钟瓶颈） |
| `SERIAL-002` | medium | 命中 10 | hit（很可能） | both | 源码相邻但无数据引用的 agent 调用 → 可并行候选（需语义确认） |
| `TIMEOUT-001` | medium | 通过 | 未启用 | pass | agent 调用缺少 timeoutMs 且无 run 级超时 → 单点挂起会拖垮整阶段 |
| `RETRY-001` | low | 命中 13 | 未启用 | static-hit | retries 放大失败场景下的调用量与 token 消耗 |
| `DET-001` | low | 命中 4 | hit（确定） | both | prompt 语义看起来可用确定性 JS 完成（统计/校验），交给 LLM 是浪费 |
| `REC-001` | high | 通过 | 未启用 | pass | 大规模任务且无 phase 边界 → 失败后只能整 run 重跑 |
| `REC-002` | high | 静态不判定（由 AI 检查） | hit（确定） | ai-hit | 恢复模式（retry/resume/from-stage）读取的收窄集合没有沿调用链传给下游 workflow → 恢复退化为全量重跑 |
| `IO-001` | medium | 命中 11 | 未启用 | static-hit | agent prompt 要求用 read/write 工具处理文件 → 确定性 IO 走了模型往返 |
| `INPUT-002` | medium | 通过 | 未启用 | pass | 阶段起点分支要求了该阶段并不需要的输入 → 阶段级恢复被无关输入阻断 |
| `BUDGET-001` | high | 静态不判定（由 AI 检查） | pass（确定） | pass | 入口并行调度子 workflow，子流程内部又动态并行，但并发预算未显式切分 → 实际在途数可能翻倍 |
| `SIDEFX-001` | high | 静态不判定（由 AI 检查） | hit（确定） | ai-hit | SERIAL-002 报出的并行候选实际通过文件路径或共享状态存在隐式依赖 → 不能并行化 |

## AI 规则检查（completed / 576s）

- 命中 5 / 待确认 0 / 通过 1 / 失败 0（共 6 条）

### HIT `CONC-002`（置信度 0.90（确定））

- 判定依据：7 处 parallel( 调用中有 2 处满足命中口径（第一参数为标识符.map(...)，且标识符声明处非可静态定长字面量）：10-unified-spec.js:177 的 structure.stages 来自行 58 的 agent 回读（const structure = await agent(），2-atomize-requirements.js:159 的 stageSections 来自行 54 的 args 属性（const stageSections = scan.stageSections），分片数均运行时才可知。其余调用点（4-client-verify.js:240、5-server-verify.js:237 的 partFiles 与 7-business-behavior.js:253 的 partDocs 声明处为 [] 字面量，game-requirement-audit.js:568 的 tasks 为静态有界至多 2 条）不满足该口径，与静态结果 hit(2) 一致。

证据：
- `game-requirement-audit/10-unified-spec.js:L177-178`
  ```
  const stageResults = await parallel(
    structure.stages.map((s) => () =>
  ```
- `game-requirement-audit/2-atomize-requirements.js:L159-160`
  ```
  const atomizeResults = await parallel(
    stageSections.map((s) => () =>
  ```

### HIT `SERIAL-002`（置信度 0.70（很可能））

- 判定依据：静态确认 10 组相邻串行调用无标识符交集，源码逐组复核成立：三组典型均为「agent() 调用相邻 + 中间只夹 commandSuccess/check 等非 agent/workflow 调用 + 彼此不引用对方结果标识符」。其中 10-unified-spec 的 plannerResult(274)→finalStats(312) 是真候选：finalStats 只回读早已定稿的 verify-report.md，与 plannerResult 写策划版互不依赖，可同批并行；11-human-review 的 applic(66)→applied(120) 组 applied 读取的 impact-set.json 由中间 apply-decisions 命令产出，属规则警示的隐含副作用顺序（applic 本身可先行并行，applied 必须跟在命令后）；1-scan-template 的 scan(101)→echo 落盘(180) 组 echo 的 prompt 载荷 scanText 由 scan.totalLines 与 sections（派生自 scan.sections）构成，存在传递性数据依赖，非安全并行候选。另在源码确认 2-atomize-requirements 159→217（recount 不引用 atomizeResults，但组内含 stageSections.map 动态节点，按规则组内置信度降 0.40）与 4-client-verify 379→412（写清单 agent 与 merged 回读相邻，中间仅两条命令）同类命中。

证据：
- `1-scan-template.js:L101-180`
  ```
  await agent(echoPrompt(scanText, scanPath), {
  ```
- `game-requirement-audit/10-unified-spec.js:L274-312`
  ```
  const finalStats = await agent(
  ```
- `game-requirement-audit/11-human-review.js:L66-120`
  ```
  const applied = await agent(
  ```

### HIT `DET-001`（置信度 0.85（确定））

- 判定依据：命中关键词组1（编号）。按『每组取首个命中 agent』口径报告 S1 扫描 agent（静态分析同判）：agent() 首参为字符串数组 join 字面量，prompt 开头自述『只做章节扫描与归类，不解读内容』，任务是读取模板、识别章节结构、按归类规则输出有序章节列表并连续编号 stageId——标题识别/归类/连续编号/覆盖全文检查均为正则+计数器可确定性完成的活，且同文件 127-175 行已用确定性 JS 对该 agent 输出做排序、查重、覆盖与编号连续校验，证明 JS 等价实现已存在。关键词组2（校验/核对格式/字段是否齐全）无 prompt 开头命中（『校验』仅出现在语义分析 prompt 中部的返回摘要自查指令，主任务仍是语义判断），不报。组1后续同型命中（S3/S10『统计回读器』、S4/S5『只做提取与去重』归集器、S8/S9/S11 计数/统计回读）按每组最多报一条不再展开。

证据：
- `1-scan-template.js:L101-120`
  ```
  你是需求规格工作流的模板结构扫描器，工作目录为项目根目录。只做章节扫描与归类，不解读内容。
  ```
- `1-scan-template.js:L112-112`
  ```
  5. kind=stage 条目按文档顺序编 stageId：ST-C01、ST-C02……连续编号。
  ```

### HIT `REC-002`（置信度 0.90（确定））

- 判定依据：mode=retry 分支（行418）用 readBack 读取 impact-set.json 并访问 impact.impactSet（行448-451，仅做空值校验与 log），但 impact 是 if 块内 const，读取值未存入任何贯穿变量；runStage（行479）与 S4∥S5 并行块（行582）传给 workflow() 的 impactSet 都是 stageResults.impactSet || null，而 stageResults.impactSet 在全文件从未被赋值（仅 479/582 两处读取，其余赋值只有 S1~S11 键），子流程恒收到 null。且下游无兜底通道：S4/S5 不读 A.impactSet，prepare-verify-input.mjs 全文无 retry/impact 引用，只按 stageIds（默认 ALL）对全量 Registry 分片——收窄集合读取后即丢失，三条命中判定全部满足。

证据：
- `game-requirement-audit/game-requirement-audit.js:L418-422`
  ```
  if (mode === 'retry') {
    phase('阶段复用')
    const impact = await readBack(
      '回读影响集合',
      runDir + '/6-review/runtime/impact-set.json',
  ```
- `game-requirement-audit/game-requirement-audit.js:L450-451`
  ```
  'retry（' + retryScope + '）：重跑影响集合 client ' + impact.impactSet.client.length +
        ' / server ' + impact.impactSet.server.length + ' 个原子，自 ' + startStage + ' 起'
  ```
- `game-requirement-audit/game-requirement-audit.js:L476-479`
  ```
        trigger: mode === 'retry' ? 'retry' : mode === 'resume' ? 'resume' : 'initial',
        plannerPath: runDir + '/5-specs/策划版.md',
        retryScope: retryScope,
        impactSet: stageResults.impactSet || null,
  ```
- `game-requirement-audit/game-requirement-audit.js:L580-582`
  ```
                stageIds: stageIds,
                retryScope: retryScope,
                impactSet: stageResults.impactSet || null,
  ```

### HIT `SIDEFX-001`（置信度 0.90（确定））

- 判定依据：S7/S8 的「分片写盘器」agent 与其后并行 agents 构成 SERIAL-002 候选（源码相邻、写盘器返回值被丢弃、并行侧 prompt 无变量引用），但存在磁盘隐式依赖——并行 agents 读取的正是写盘器刚写的分片文件。8-difference-review.js：写盘器（96 行 await agent，98 行指令「把下列 JSON 数组按顺序拆成独立文件写盘」）按 99 行 '第 N 个 → REVIEW_DIR + "/input/" + p.file' 写入，紧随的并行差异复核 agents（206 行 parallel）prompt 135 行又以 '1. 本片原子清单：' + REVIEW_DIR + '/input/' + p.file 读取同一批文件——路径表达式逐字相同，命中判定条件 1（路径重合）+ 条件 2（写后读）。7-business-behavior.js 同构：写盘器（118 行调用）按 121 行 '第 N 个 → p.path' 写 behavior-parts 分片（p.path = PARTS_DIR + '/' + stageId + '-bp01.json'），并行行为还原 agents（253 行 parallel）prompt 162 行以 '1. 本片清单：' + p.path 读取。静态列出的三组候选（1-scan-template 101-180、10-unified-spec 274-312、11-human-review 66-120）已逐一核查：双方 prompt 或均为只读、或读写路径不相交（scan 只读模板/echo 只写 scan.json；planner 写策划版.md/finalStats 读 verify-report.md；applic 与 applied 各读不同 runtime 文件），不构成命中；命中集中在 S7/S8 分片写盘器 → 并行读盘 agent 这两组。

证据：
- `game-requirement-audit/8-difference-review.js:L99-99`
  ```
  partDocs.map((p, i) => '  第 ' + (i + 1) + ' 个 → ' + REVIEW_DIR + '/input/' + p.file).join('\n'),
  ```
- `game-requirement-audit/8-difference-review.js:L135-135`
  ```
  '1. 本片原子清单：' + REVIEW_DIR + '/input/' + p.file,
  ```
- `game-requirement-audit/7-business-behavior.js:L121-121`
  ```
  partDocs.map((p, i) => '  第 ' + (i + 1) + ' 个 → ' + p.path).join('\n'),
  ```


## 发现的问题（37 条 → 5 个问题簇）

### 1. IO-001 · 11 处同类问题

- 严重度: medium / 置信度: 0.80（很可能） — 依据较强，核对一眼后改
- 涉及文件: game-requirement-audit/10-unified-spec.js, game-requirement-audit/11-human-review.js, game-requirement-audit/2-atomize-requirements.js, game-requirement-audit/3-build-registry.js, game-requirement-audit/4-client-verify.js, game-requirement-audit/5-server-verify.js, game-requirement-audit/6-merge-evidence.js, game-requirement-audit/7-business-behavior.js 等 11 个
- 位置: game-requirement-audit/10-unified-spec.js:L58-312；game-requirement-audit/11-human-review.js:L66-120；game-requirement-audit/2-atomize-requirements.js:L217-217；game-requirement-audit/3-build-registry.js:L51-51；game-requirement-audit/4-client-verify.js:L66-412；game-requirement-audit/5-server-verify.js:L64-381；game-requirement-audit/6-merge-evidence.js:L30-30；game-requirement-audit/7-business-behavior.js:L50-300；game-requirement-audit/8-difference-review.js:L43-241；game-requirement-audit/9-classify-l7.js:L30-30（另有 1 处，见 JSON）

- 2 处 agent 调用把确定性文件 IO 交给模型（行 58, 312）
- 首处：回读器自述 —— 你是规格结构读取器，工作目录为项目根目录。只做读取与转写，不做解读。 任务：read （可能较大，可分段读），返回： 1
- 2 处 agent 调用把确定性文件 IO 交给模型（行 66, 120）
- 首处：回读器自述 —— 你是文件回读器，工作目录为项目根目录。只做读取与转写。 任务：read /6-review/runtime/decisi
- 1 处 agent 调用把确定性文件 IO 交给模型（行 217）
- 首处：读写工具指令 —— 你是拆解重算结果回读器，工作目录为项目根目录。只做读取与转写，不做解读。 任务：用 read 工具读取文件 （全文），原

代表代码：
```js
const structure = await agent(
  [
    '你是规格结构读取器，工作目录为项目根目录。只做读取与转写，不做解读。',
```

**建议**：优先改用受治理的 readFile/writeFileAtomic（带路径白名单、原子写、hash 校验）；无法迁移时至少给写盘加写后回读 hash 校验

### 2. SERIAL-002 · 9 处同类问题

- 严重度: medium / 置信度: 0.70（很可能） — 依据较强，核对一眼后改
- 涉及文件: E:\WorkProjects\PrdGameSkill\.opencode-workflows\workflows\game-requirement-audit\1-scan-template.js, game-requirement-audit/10-unified-spec.js, game-requirement-audit/11-human-review.js, game-requirement-audit/4-client-verify.js, game-requirement-audit/5-server-verify.js, game-requirement-audit/7-business-behavior.js, game-requirement-audit/8-difference-review.js
- 位置: E:\WorkProjects\PrdGameSkill\.opencode-workflows\workflows\game-requirement-audit\1-scan-template.js:L101-180；game-requirement-audit/10-unified-spec.js:L274-312；game-requirement-audit/11-human-review.js:L66-120；game-requirement-audit/4-client-verify.js:L301-364；game-requirement-audit/4-client-verify.js:L379-412；game-requirement-audit/5-server-verify.js:L283-339；game-requirement-audit/5-server-verify.js:L353-381；game-requirement-audit/7-business-behavior.js:L50-118；game-requirement-audit/8-difference-review.js:L43-96

- 2 个调用源码相邻但无数据引用（call-1, call-2）
- 2 个调用源码相邻但无数据引用（call-4, call-5）
- 3 个调用源码相邻但无数据引用（call-4, call-5, call-6）
- 组内含动态或存在 Explicit 依赖的节点：call-5——需语义确认后才可并行化
- 2 个调用源码相邻但无数据引用（call-7, call-8）
- 组内含动态或存在 Explicit 依赖的节点：call-7——需语义确认后才可并行化

代表代码：
```js
const scan = await agent(
  [
    '你是需求规格工作流的模板结构扫描器，工作目录为项目根目录。只做章节扫描与归类，不解读内容。',
```

**建议**：经语义确认业务独立后可改为 parallel；静态 Candidate 不构成自动并行化依据

### 3. CONC-002 · 2 处同类问题

- 严重度: medium / 置信度: 0.40（仅提示） — 依据不足，仅作检查线索，不计入风险分
- 涉及文件: game-requirement-audit/10-unified-spec.js, game-requirement-audit/2-atomize-requirements.js
- 位置: game-requirement-audit/10-unified-spec.js:L177-177；game-requirement-audit/2-atomize-requirements.js:L159-159

- 并行任务数来自运行时集合 `structure.stages`（map），静态不可知
- 并发上限：未声明（运行时默认 CPU-2，上限 16）
- 单次超时：3600s
- 并行任务数来自运行时集合 `stageSections`（map），静态不可知

代表代码：
```js
const stageResults = await parallel(
```

**建议**：确认三件事：①分片数（决定波次数）②并发上限是否匹配（setConcurrency 或 run 参数）③单次超时是否够。分片多 + 单次长会造成多波次长尾，是墙钟主要来源

### 4. RETRY-001 · 12 处同类问题

- 严重度: low / 置信度: 0.80（很可能） — 依据较强，核对一眼后改
- 涉及文件: E:\WorkProjects\PrdGameSkill\.opencode-workflows\workflows\game-requirement-audit\1-scan-template.js, game-requirement-audit/10-unified-spec.js, game-requirement-audit/11-human-review.js, game-requirement-audit/2-atomize-requirements.js, game-requirement-audit/3-build-registry.js, game-requirement-audit/4-client-verify.js, game-requirement-audit/5-server-verify.js, game-requirement-audit/6-merge-evidence.js 等 12 个
- 位置: E:\WorkProjects\PrdGameSkill\.opencode-workflows\workflows\game-requirement-audit\1-scan-template.js:L101-120；game-requirement-audit/10-unified-spec.js:L58-104；game-requirement-audit/11-human-review.js:L66-101；game-requirement-audit/2-atomize-requirements.js:L161-170；game-requirement-audit/3-build-registry.js:L51-76；game-requirement-audit/4-client-verify.js:L66-98；game-requirement-audit/5-server-verify.js:L64-95；game-requirement-audit/6-merge-evidence.js:L30-60；game-requirement-audit/7-business-behavior.js:L50-84；game-requirement-audit/8-difference-review.js:L43-74（另有 2 处，见 JSON）

- retries 最高 2 次
- agent 调用点 2 个
- 失败场景最坏调用量 ≈ 6
- agent 调用点 4 个
- 失败场景最坏调用量 ≈ 12
- agent 调用点 1 个

代表代码：
```js
const scan = await agent(
  [
    '你是需求规格工作流的模板结构扫描器，工作目录为项目根目录。只做章节扫描与归类，不解读内容。',
```

**建议**：全量失败时重试会造成成倍 token 消耗，配合 M3 任务级恢复只重跑失败任务

### 5. DET-001 · 3 处同类问题

- 严重度: low / 置信度: 0.50（待确认） — 依据一般，需人工判断（可能误报）
- 涉及文件: E:\WorkProjects\PrdGameSkill\.opencode-workflows\workflows\game-requirement-audit\1-scan-template.js, game-requirement-audit/4-client-verify.js, game-requirement-audit/5-server-verify.js
- 位置: E:\WorkProjects\PrdGameSkill\.opencode-workflows\workflows\game-requirement-audit\1-scan-template.js:L101-120；game-requirement-audit/4-client-verify.js:L339-358；game-requirement-audit/5-server-verify.js:L319-333

- prompt 语义疑似确定性任务：你是需求规格工作流的模板结构扫描器，工作目录为项目根目录。只做章节扫描与归类，不解读内容。 任务：完整读取模板文件 （可分多次读取），识别文档章节结构，返回有序章节列表。 章节归类规则： 1. 从第 1 行到第一个「## 」标题之前为文档引言（标题 + 概述段落），kind=intro，title 填文档主标题。 2. 「## 名词」术语章节 kind=terms；模板没有名词章节时不输出 terms 条目。 3. 全部「### 」级小节 kind=stage；某 ### 是其「## 」容器下第一个子节时，fromLine 取该 ## 标题行行号（把容器标题与…（完整内容见 JSON）
- prompt 语义疑似确定性任务：你是证据文件归集器，工作目录为项目根目录。只做提取与去重，不做判断。 任务：读取目录  下全部 *-cp*.json 分片（可逐个 read）， 提取每个分片 evidence[] 条目的 file 字段与 dependencyFiles[].file 字段， 按 "repoId:file" 形式去重后返回列表（repoId 取证据条目的 repoId 字段）。 只要文件路径，不要其他信息。只输出结构化结果。
- prompt 语义疑似确定性任务：你是证据文件归集器，工作目录为项目根目录。只做提取与去重，不做判断。 任务：读取目录  下全部 *-p*.json 分片， 提取 evidence[] 的 file 与 dependencyFiles[].file，去重后返回列表（只需 file 路径，repoId 恒为 server）。 只输出结构化结果。

代表代码：
```js
const scan = await agent(
  [
    '你是需求规格工作流的模板结构扫描器，工作目录为项目根目录。只做章节扫描与归类，不解读内容。',
```

**建议**：统计/计数/去重/排序类任务优先用 JS 确定性完成

## 子 Workflow 明细

- 聚合口径：取最危险单文件（不相加，避免虚高）
- 规则分布：SERIAL-002×9, DET-001×3, RETRY-001×12, CONC-002×2, IO-001×11

| 文件 | 风险分 | 调用点 | finding | 主要规则 |
| --- | --- | --- | --- | --- |
| game-requirement-audit/10-unified-spec.js | 9 | 4 | 4 | CONC-002 |
| game-requirement-audit/11-human-review.js | 9 | 2 | 3 | SERIAL-002 |
| game-requirement-audit/2-atomize-requirements.js | 3 | 2 | 3 | CONC-002 |
| game-requirement-audit/3-build-registry.js | 3 | 1 | 2 | IO-001 |
| game-requirement-audit/4-client-verify.js | 9 | 7 | 5 | IO-001 |
| game-requirement-audit/5-server-verify.js | 9 | 7 | 5 | IO-001 |
| game-requirement-audit/6-merge-evidence.js | 3 | 1 | 2 | IO-001 |
| game-requirement-audit/7-business-behavior.js | 14 | 4 | 3 | IO-001 |
| game-requirement-audit/8-difference-review.js | 14 | 4 | 3 | IO-001 |
| game-requirement-audit/9-classify-l7.js | 3 | 1 | 2 | IO-001 |
| game-requirement-audit/game-requirement-audit.js | 3 | 5 | 2 | IO-001 |

## 优化建议

### OPT-001 经语义确认业务独立后可改为 parallel
- 严重度: medium / 质量风险: low
- 预期收益: 待 Benchmark 验证（静态估算不提供数值收益）
- 验证条件: 重新运行 Analyzer 确认风险消除；Benchmark 对比耗时与 Token 不劣化

### OPT-002 统计/计数/去重/排序类任务优先用 JS 确定性完成
- 严重度: low / 质量风险: low
- 预期收益: 待 Benchmark 验证（静态估算不提供数值收益）
- 验证条件: 重新运行 Analyzer 确认风险消除；Benchmark 对比耗时与 Token 不劣化

### OPT-003 全量失败时重试会造成成倍 token 消耗，配合 M3 任务级恢复只重跑失败任务
- 严重度: low / 质量风险: low
- 预期收益: 待 Benchmark 验证（静态估算不提供数值收益）
- 验证条件: 重新运行 Analyzer 确认风险消除；Benchmark 对比耗时与 Token 不劣化
