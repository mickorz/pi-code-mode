# Analysis 报告与 Dashboard 优化可行性分析

- 日期：2026-11-19
- 需求：参考 `thirdparties/PrdGameSkill/.claude/skills/game-prd-check` 的报告与 Dashboard 做法，把 pi-code-mode 的 `/workflows analyze` 输出升级为「完整 Markdown 报告 + HTML Dashboard，并自动用浏览器打开」
- 结论：**可行**。核心管线可在一期内完成（预估 1.5 人日），且比参考实现**少一个环节**（我们是结构化 JSON 直出，无需反向解析 Markdown）

---

## 一、参考实现机制分析（game-prd-check）

### 1.1 它的管线

```
报告生成（Agent 写 report.md）
   ↓
node scripts/build-dashboard.mjs <report.md>
   ↓
① 解析 report.md → report.json（含 validateReport 校验，失败 exit 1）
② 注入 dashboard/template.html 的 __REPORT_JSON__ 占位符
③ 输出 report.json + dashboard/{项目名}分析-Dashboard-{YYYYMMDD}-{NN}.html
```

### 1.2 关键设计（值得照搬的 5 点）

| 设计 | 实现方式 | 价值 |
| --- | --- | --- |
| **零依赖单文件 HTML** | 原生 JS + 内联 CSS + SVG 图表，无 CDN/无构建 | `file://` 双击即开，离线可用，可随报告归档 |
| **数据内嵌而非 fetch** | `<script type="application/json" id="report-data">__REPORT_JSON__</script>` | 规避 `file://` 的 CORS/fetch 限制（这是能否双击打开的关键） |
| **生成前强校验** | `validateReport()` 校验不过直接 `exit 1`，不产出残缺 HTML | 避免"打开是空白页" |
| **同日递增不覆盖** | `{safeName}分析-Dashboard-{YYYYMMDD}-{NN}.html`，扫描目录取 max+1 | 保留历史对比版本 |
| **点击图表即筛选** | 优先级条/类型环形图/模块柱 → 过滤问题列表 | Dashboard 有交互价值，不是静态图 |

### 1.3 它为什么必须解析 Markdown

因为 skill 场景下 **report.md 是 Agent 直接书写、唯一的产物**，没有结构化数据源，只能反向解析——`build-dashboard.mjs` 为此写了三种格式适配器（skill 版 / workflow 版 / UI 交互基准版），共 802 行，其中大部分是正则与容错。

**这是我们可以省掉的一层**：pi-code-mode 的 `AnalysisReport` 本身就是结构化 JSON。

---

## 二、当前 pi-code-mode 的差距

| 维度 | 现状 | 差距 |
| --- | --- | --- |
| 结构化数据 | `AnalysisReport`（ruleInventory / findings / subtree / dependencies / estimate） | ✅ 已足够，是 Dashboard 的天然数据源 |
| Markdown 报告 | 已含检查清单表 + finding 详情 + 代码片段 + 子 workflow 表 | 缺：优先级体系、影响/验收口径、目录 |
| HTML Dashboard | **无** | 全新 |
| 自动打开浏览器 | **无** | 全新 |
| 报告落盘 | `.pi/workflows/reports/<name>.analysis.{md,json}` | 需加 dashboard 子目录与命名规则 |

---

## 三、优化方案

### 3.1 数据模型映射（关键决策）

不引入新的报告格式，**直接扩展 `AnalysisReport`**，dashboard 消费它：

| Dashboard 概念 | 现有字段 | 处理 |
| --- | --- | --- |
| 优先级 P0-P3 | `finding.severity`（critical/high/medium/low） | 映射：critical→P0, high→P1, medium→P2, low→P3。**不新增字段**，渲染时映射 |
| 问题类型 | `ruleId` + 规则 `description` | 直接用规则作为"检查维度"，无需类型枚举 |
| 检查覆盖 | `ruleInventory`（status: hit/pass/error） | 新增 Tab「规则检查清单」 |
| 模块分布 | `subtree.subWorkflows[].file` | 子 workflow 作为"模块"维度 |
| 图表数据 | `summary.counts`、`subtree.rules`、`subtree.subWorkflows` | 全部现成 |
| 静态不可判定 | `dependencies.unknowns` | 独立 Tab（这是我们的特色，PRD 报告没有） |

**结论：Dashboard 所需数据 100% 已在 AnalysisReport 里，无需改分析逻辑。**

### 3.2 HTML Dashboard 设计

```
src/analyzer/dashboard/
  template.html      # 零依赖单文件模板，含 __REPORT_JSON__ 占位符
  build-dashboard.ts # AnalysisReport → 视图模型 → 注入模板 → 落盘
```

**5 个 Tab**：

| Tab | 内容 |
| --- | --- |
| 概览 | KPI 卡（风险分/文件数/调用点/finding 数）、风险分级条形图、规则命中分布、子 workflow 风险 Top |
| 规则检查清单 | 全量 9 条规则 × 状态（通过/命中 N/执行失败）× 检查说明 |
| 问题列表 | findings 表（严重度/规则/位置/证据/代码片段），支持按 severity 与 ruleId 点击筛选 |
| 子 Workflow | 12 个文件的 risk/calls/findings/主要规则表 + 横向条形图 |
| 静态不可判定 | unknowns 列表（明确标注"禁止据此并行化"） |

**体积控制**（必须做）：

- 内嵌 JSON 只放"渲染需要的"：`summary` / `ruleInventory` / `findings`（含 snippet）/ `subtree` 摘要 / `unknowns`
- **不内嵌**每份子文件的完整 report（12 文件全量会到 MB 级）
- 预估产物：单文件 150~300 KB，可接受

**命名与位置**：

```
.pi/workflows/reports/
  <name>.analysis.md
  <name>.analysis.json
  dashboard/<name>分析-Dashboard-{YYYYMMDD}-{NN}.html   # 同日递增不覆盖
```

### 3.3 自动打开浏览器

```ts
// src/utils/open-browser.ts
export function openInBrowser(filePath: string): { ok: boolean; error?: string }
```

| 平台 | 命令 |
| --- | --- |
| Windows | `cmd /c start "" "<file:///...>"`（空 title 占位必需，否则引号会被当标题） |
| macOS | `open "<path>"` |
| Linux | `xdg-open "<path>"` |

**安全默认**：

- 默认开启；`--no-open` 关闭（CI/远程终端）
- 非交互环境（无 TTY 或 `CI=1`）自动跳过并提示路径
- 打开失败只 warn，不阻断命令成功（报告文件已生成，路径已打印）

### 3.5 规则文件化（新增，最高优先）

参考实现的 `references/rules/` 用 `NN-主题.md` 组织 42 个规则文件，好处是"人能直接翻规则"。
但两者规则**性质不同**，不能照抄结构：

| | 参考实现（game-prd-check） | pi-code-mode |
| --- | --- | --- |
| 规则是什么 | **业务语义基准**（"财神翻出来要染色"） | **静态检查规则**（"parallel 任务数不可确定时提示"） |
| 用途 | 作为"正确答案"去对照 PRD 文档 | 作为检查项去扫描代码 |
| 文件结构 | 什么时候出现 / 数据记录 / 界面变化 / 连带影响 / 重连回放 | 需改为：检查什么 / 为什么是问题 / 命中判定 / 证据 / 局限 / 验收 |

因此借鉴**组织方式**（编号 + 一规则一文件），不借鉴**内容骨架**。

#### 目录与命名

```
src/engine/analyzer/rules/
  index.ts                    # 规则实现（现有）
  definitions/                # 新增：一规则一份可读文档
    01-INPUT-001-rule.md
    02-CONC-001-rule.md
    03-CONC-002-rule.md
    04-SERIAL-001-rule.md
    05-SERIAL-002-rule.md
    06-TIMEOUT-001-rule.md
    07-RETRY-001-rule.md
    08-DET-001-rule.md
    09-REC-001-rule.md
```

编号顺序 = 报告「检查清单」表顺序，便于对照。

#### 规则文件模板

```md
# CONC-002：并行任务数在运行时才确定

| 元信息 | 值 |
| --- | --- |
| 规则 ID | CONC-002 |
| 严重度 | medium |
| 置信度 | 0.4（提示性，**不计入风险分**） |
| 检查方式 | AST 静态分析 |
| 规则集版本 | 1.0 |

## 检查什么
一句话定义（与代码里 `AnalyzerRule.description` **必须一致**）。

## 为什么是问题
不改会导致什么（这是 Markdown 报告「影响」列的来源）。

## 命中判定（实现口径）
精确说明什么代码形态会命中，含正例/反例代码片段。
必须写明**不命中**的情况（防误报）。

## 报出的证据
列出的 evidence 字段各是什么含义。

## 建议怎么改
可执行改法；收益无基准时一律写「待 Benchmark」。

## 已知误报与局限
诚实列边界（如"静态不可知分片数，只能提示不能判定"）。

## 验收口径
改完怎么算通过（Analyzer 不再报 + 可选 Benchmark）。

## 关联
相关规则 / 经验文档 / 测试文件。
```

#### 三条强制约束（防文档与实现漂移）

1. **双向一致性守卫测试**（`tests/analyzer/rules-docs.test.ts`）：
   - 每个 `BUILTIN_RULES` 里的规则 → 必须存在 `definitions/NN-<ID>-rule.md`
   - 每个 `definitions/*-rule.md` → 必须能对应到代码里存在的规则
   - 文件名前缀编号必须连续从 01 起、无重复
2. **`description` 单一真相源**：代码里的 `AnalyzerRule.description` 与 md 的「检查什么」首句逐字一致（测试断言）。
3. **新规则三步**：写 `definitions/NN-xxx-rule.md` → 加实现到 `index.ts` → 跑守卫测试。

#### 当前规则清单（9 条，代码已实现 + 均有测试）

| # | 规则 ID | 严重度 | 检查什么 | 文件 |
| --- | --- | --- | --- | --- |
| 01 | `INPUT-001` | high | 同一个输入对象被多次注入不同 agent → 重复序列化与 token 浪费 | `01-INPUT-001-rule.md` |
| 02 | `CONC-001` | medium | 并行任务数超过并发上限 → 多波次（**要求任务数静态可确定**） | `02-CONC-001-rule.md` |
| 03 | `CONC-002` | medium | 并行任务数运行时才确定（`parallel(X.map)`）→ 提示人工确认分片数/并发/超时 | `03-CONC-002-rule.md` |
| 04 | `SERIAL-001` | low | ≥3 个 agent 构成明确数据依赖链（合理串行，但可能是墙钟瓶颈） | `04-SERIAL-001-rule.md` |
| 05 | `SERIAL-002` | medium | 源码相邻但无数据引用的调用 → 并行候选（需语义确认，不自动采纳） | `05-SERIAL-002-rule.md` |
| 06 | `TIMEOUT-001` | medium | agent 缺 `timeoutMs` 且无 run 级超时 → 单点挂起拖垮整阶段 | `06-TIMEOUT-001-rule.md` |
| 07 | `RETRY-001` | low | `retries` 放大失败场景的调用量与 token 消耗 | `07-RETRY-001-rule.md` |
| 08 | `DET-001` | low | prompt 语义看起来可用确定性 JS 完成（统计/校验） | `08-DET-001-rule.md` |
| 09 | `REC-001` | high | 大规模任务且无 `phase` 边界 → 失败后只能整 run 重跑 | `09-REC-001-rule.md` |

> 说明：这 9 条是**代码静态检查**规则。另外还有两类"检查"不在本清单内，因为它们不是代码规则：
> ① `plan_validate` 的 Plan Schema/Profile 边界校验（`src/engine/plan/plan-validator.ts`）；
> ② 运行时治理（预算拦截、任务级恢复）——属于 M2/M3 行为，不是静态分析。

#### 消费方（三处，同一份 md）

| 消费方 | 用法 |
| --- | --- |
| 报告 Markdown 检查清单表 | 末列加「规则文档」相对路径，可点击跳转 |
| Dashboard「规则检查清单」Tab | 点击规则行展开该 md 渲染的详细说明（构建时内嵌，运行时零请求） |
| 人工排查 | 直接翻 `definitions/` 就知道"到底检查了哪些项" |

**这直接回答用户的核心诉求**：报告里"没报的规则"不再是黑盒——每条规则的适用范围、判定口径、已知局限都有一份可读文档。

### 3.4 Markdown 报告补强（在现有基础上）

| 补充 | 理由 |
| --- | --- |
| 概览段（风险分 + 分级统计 + 覆盖摘要） | 现在开头只有零散几行，缺"一屏看懂" |
| 每条 finding 加「影响」 | 现在只有证据+建议，用户不知道"不改会怎样" |
| 每条 finding 加「验收口径」 | 对齐参考实现的 `acceptance` 字段：改完怎么算过 |
| 目录 | 报告变长后便于跳转 |

规则需要在 `AnalyzerRule` 增加可选 `impactHint`（一句话说明这类问题的后果），由渲染层拼装。

---

## 四、工作量与分期

| 期 | 内容 | 预估 |
| --- | --- | --- |
| **P0-0** | **规则文件化**：`definitions/` 9 份 `NN-<ID>-rule.md` + 双向一致性守卫测试 | **3h** |
| P0-1 | Markdown 报告补强（概览/影响/验收/目录）+ `impactHint` | 2h |
| P0-2 | `template.html`（5 Tab + 3 图表 + 筛选交互） | 5h |
| P0-3 | `build-dashboard.ts`（视图模型 + 校验 + 注入 + 命名） | 2h |
| P0-4 | `open-browser.ts` + `/workflows analyze` 接线（`--no-html`/`--no-open`） | 1h |
| P0-5 | 契约测试（视图模型/命名递增/校验失败/浏览器跳过）+ 真实脚本 smoke | 3h |

合计 **≈2 人日**（新增规则文件化 3h）。

---

## 五、风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 内嵌 JSON 过大（12 文件全量） | HTML 几 MB，浏览器卡 | 只内嵌渲染必需字段 + snippet 截断 3 行（已定） |
| Windows `start` 引号/中文路径 | 打不开 | 用 `execFile("cmd", ["/c","start","","<fileUrl>"])` 而非 `exec`；路径走 `pathToFileURL` |
| `file://` 下脚本被限制 | 白屏 | 数据内嵌（不 fetch）、无外部资源（照搬参考实现方案） |
| 报告与 dashboard 数据不一致 | 误导 | dashboard 由同一 `AnalysisReport` 生成（**不解析 md**），天然一致 |
| 用户不想要浏览器弹出 | 打扰 | `--no-open`；且仅在交互式 TTY 默认打开 |
| HTML 转义遗漏 | XSS/渲染错乱 | 视图模型层统一 `escapeHtml`，代码片段用 `<pre>` 文本节点 |

---

## 六、验收标准

1. `/workflows analyze <脚本>` 一条命令产出：`analysis.md` + `analysis.json` + `dashboard/*.html`，并自动打开浏览器
2. Dashboard 5 个 Tab 数据与 md 报告**逐项一致**（人工抽查 3 项：风险分、finding 数、子 workflow 行数）
3. 同日重复生成产生 `-01/-02` 递增文件，不覆盖历史
4. `--no-open` 不弹浏览器；`CI=1` 自动跳过
5. 内嵌数据不含完整子 report（产物 < 500 KB）
6. 契约测试覆盖：视图模型映射、命名递增、校验失败退出、浏览器命令构造（mock）
7. 对 `thirdparties/PrdGameSkill/.opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js` 真实产出可打开、可筛选
8. `definitions/` 下 9 份规则文档齐全，编号 01~09 连续；守卫测试通过（代码规则 ↔ md 双向对应、description 逐字一致）
9. Dashboard 规则 Tab 点击任一条规则可看到其 md 全文说明

---

## 七、明确不做

- **不复用**参考实现的 `template.html`（1220 行）：它绑定 PRD 的 14 个字段模型（type/priority/term_explain/required_format/example...），与我们的 rule/finding/subtree 模型不同构，强改成本高于重写
- **不做**从 Markdown 反解析：我们是结构化直出，反解析只会引入不一致
- **不做**远程服务/静态服务器：单文件 `file://` 已满足需求
- **不做** Dashboard 内联的模型调用或二次分析：只读展示
- **不照搬**参考实现的规则文件内容骨架（"什么时候出现 / 数据记录 / 界面变化 / 重连回放"）——那是业务语义规则的结构，与静态检查规则不匹配

---

## 引用

- 参考实现：`thirdparties/PrdGameSkill/.claude/skills/game-prd-check/`
  - 流程定义：`SKILL.md`（七阶段 + 阶段 8 Dashboard）
  - 生成器：`scripts/build-dashboard.mjs`（802 行，含三种报告格式适配 + `validateReport` + `nextDashboardName`）
  - 模板：`dashboard/template.html`（1220 行，零依赖 + SVG 图表 + 点击筛选）
  - 数据契约：`dashboard/schema/report.schema.json`
- 本项目现状：`src/engine/analyzer/report-builder.ts`（`AnalysisReport` / `renderMarkdown`）、`src/tools/workflow-analyze-tool.ts`、`extensions/commands/workflows/analyze.ts`
- 相关经验：`dev-docs/experience/analyzer-single-file-misses-subworkflows.md`、`dev-docs/experience/analyze-timeout-not-consumed.md`
