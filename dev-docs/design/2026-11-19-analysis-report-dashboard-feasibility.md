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
| P0-1 | Markdown 报告补强（概览/影响/验收/目录）+ `impactHint` | 2h |
| P0-2 | `template.html`（5 Tab + 3 图表 + 筛选交互） | 5h |
| P0-3 | `build-dashboard.ts`（视图模型 + 校验 + 注入 + 命名） | 2h |
| P0-4 | `open-browser.ts` + `/workflows analyze` 接线（`--no-html`/`--no-open`） | 1h |
| P0-5 | 契约测试（视图模型/命名递增/校验失败/浏览器跳过）+ 真实脚本 smoke | 3h |

合计 **≈1.5 人日**。

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

---

## 七、明确不做

- **不复用**参考实现的 `template.html`（1220 行）：它绑定 PRD 的 14 个字段模型（type/priority/term_explain/required_format/example...），与我们的 rule/finding/subtree 模型不同构，强改成本高于重写
- **不做**从 Markdown 反解析：我们是结构化直出，反解析只会引入不一致
- **不做**远程服务/静态服务器：单文件 `file://` 已满足需求
- **不做** Dashboard 内联的模型调用或二次分析：只读展示

---

## 引用

- 参考实现：`thirdparties/PrdGameSkill/.claude/skills/game-prd-check/`
  - 流程定义：`SKILL.md`（七阶段 + 阶段 8 Dashboard）
  - 生成器：`scripts/build-dashboard.mjs`（802 行，含三种报告格式适配 + `validateReport` + `nextDashboardName`）
  - 模板：`dashboard/template.html`（1220 行，零依赖 + SVG 图表 + 点击筛选）
  - 数据契约：`dashboard/schema/report.schema.json`
- 本项目现状：`src/engine/analyzer/report-builder.ts`（`AnalysisReport` / `renderMarkdown`）、`src/tools/workflow-analyze-tool.ts`、`extensions/commands/workflows/analyze.ts`
- 相关经验：`dev-docs/experience/analyzer-single-file-misses-subworkflows.md`、`dev-docs/experience/analyze-timeout-not-consumed.md`
