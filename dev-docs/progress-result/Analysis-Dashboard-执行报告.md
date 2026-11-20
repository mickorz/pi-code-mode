# Analysis Dashboard 执行报告

- 日期：2026-11-19
- 阶段目标：让 `/workflows analyze` 产出「完整 Markdown 报告 + HTML Dashboard + 自动打开浏览器」，并用真实入口 `game-requirement-audit.js` 验证「rule 检查」与「AI 分析」是否清晰可读
- 结论：**达成**。5 个 Tab 全部经浏览器实拍 + 图像分析逐项验收，数据自洽，无渲染缺陷

---

## 一、交付清单

| # | 交付 | 位置 |
|---|---|---|
| 1 | 规则文件化（9 份 `NN-<ID>-rule.md`） | `src/engine/analyzer/rules/definitions/` |
| 2 | 规则文档双向一致性守卫 | `tests/analyzer/rules-docs.test.ts`（5 用例） |
| 3 | AI Planner 超时修复（根因：prompt 形态） | `src/engine/analyzer/optimization-planner.ts` |
| 4 | AI 建议合并修复（不再被静默丢弃）+ `[AI]` 来源标记 | 同上 + `report-builder.ts` |
| 5 | Dashboard 视图模型 + 生成器 | `src/engine/analyzer/dashboard/build-dashboard.ts` |
| 6 | Dashboard 模板（零依赖单文件，5 Tab） | `src/engine/analyzer/dashboard/template.html` |
| 7 | 跨平台打开浏览器 | `src/utils/open-browser.ts` |
| 8 | `/workflows analyze` 接线（`--no-open`） | `extensions/commands/workflows/analyze.ts` |
| 9 | Dashboard 契约测试 | `tests/analyzer/dashboard.test.ts`（10 用例） |
| 10 | 构建复制模板（dist 可用） | `package.json` build 脚本 |

---

## 二、真实场景验证（game-requirement-audit.js）

入口：`thirdparties/PrdGameSkill/.opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js`（714 行壳 + 11 个子流程）

| 指标 | 结果 |
|---|---|
| 静态分析耗时 | **127ms** |
| 聚合文件数 | **12**（入口 + 11 子流程） |
| 聚合调用点 | **40** |
| findings | **23** |
| 最高单文件风险 | 7/100（`1-scan-template.js`） |
| AI 复核耗时 | 84~135s（波动大，见遗留） |
| AI 建议 | 2~4 条，`[AI]` 标记，正确标注「需语义确认」「待 Benchmark」 |
| Dashboard 体积 | 36 KB（单文件，`file://` 直接打开） |

规则命中分布（合并子流程后）：

| 规则 | 结果 |
|---|---|
| RETRY-001 | 命中 13 |
| SERIAL-002 | 命中 9 |
| CONC-002 | 命中 2 |
| INPUT-001 / CONC-001 / SERIAL-001 / TIMEOUT-001 / DET-001 / REC-001 | 通过（已执行） |

---

## 三、5 个 Tab 验收结果（浏览器实拍）

| Tab | 内容 | 验收 |
|---|---|---|
| 概览 | 8 个 KPI + 严重度分布（medium 11 / low 12）+ 规则命中分布 + AI 总体判断 | ✅ 数据自洽（11+12=23，3/9 命中一致） |
| 规则检查 | 全 9 条规则 × 严重度 × 结果（通过/命中 N）× 检查项说明 | ✅ 9 行完整，无截断，明确标注「通过 = 检查过且未发现问题」 |
| 问题列表 | 23 条，含来源文件、行号、置信度、证据、代码片段、建议；severity/rule 筛选 | ✅ 覆盖 12 个文件，代码片段正常 |
| 子 Workflow | 聚合概览 + 各文件风险条形图 + 明细表 | ✅ 12 文件 / 40 调用点 / 规则分布正确 |
| 建议与 AI | AI 建议（[AI] 徽章）与静态建议分区，含验证条件；静态不可判定清单 | ✅ 字段齐全，空态提示正常 |

---

## 四、真实场景暴露并修复的 4 个缺陷

| # | 缺陷 | 根因 | 影响 |
|---|---|---|---|
| 1 | **问题列表只有 1 条、规则页显示「全通过」** | 子流程 findings 未并入视图模型 | 用户会误以为没风险（实际 23 条） |
| 2 | **「23 条问题但严重度分布只有 1 条」** | 合并后未重算 `summary.counts` | 数据自相矛盾 |
| 3 | **`cmd /c start "file://..."` 弹窗「系统找不到文件」** | `file://` URL 的中文路径 `%XX` 编码被当路径 | 每次分析弹 cmd 报错窗 |
| 4 | **Dashboard 通知挤掉核心摘要** | 单独 notify | 用户看不到风险分 |

对应修复与守卫：

1. `tree-analyzer.ts` 的 `SubWorkflowSummary` 增加 `findings` 明细 → `build-dashboard.ts` 合并并标 `file`
2. 合并后重算 `counts`（测试断言 `Σcounts === findings.length`）
3. Windows 改用 `explorer.exe <绝对路径>`（`cmd /c start` 完全弃用），并加文件存在性校验（explorer 成功/失败都返回 1，不能靠退出码判断）
4. Dashboard 路径并入摘要；只有真的尝试打开且失败时才额外 notify

---

## 五、测试

| 套件 | 结果 |
|---|---|
| analyzer | **82/82**（新增 rules-docs 5 + dashboard 10） |
| contract | **123/123** |
| engine | **206/206** |

关键守卫：

- `rules-docs.test.ts`：9 条规则 ↔ 9 份文档双向对应、编号连续、`description` 逐字一致、必需段落齐全
- `dashboard.test.ts`：子树 findings 必须并入、counts 必须重算、规则 hits 必须合并、校验失败不产出、同日递增命名、`</script>` 转义、覆盖模式不产生 -02、三平台打开命令、CI 跳过
- `analyze-command.test.ts`：dashboard 落盘 + 命名格式 + `--no-open` 提示

---

## 六、遗留问题

1. **AI 复核耗时 84~135s 且波动大**：zhipu 只有 reasoning 模型（`glm-5.3-flash`/`glm-5.3`）。瘦身后 prompt 1159 字符已能稳定返回，但输出长度波动导致耗时不稳。超时设 240s。
2. **AI 阶段仍阻塞**：CLI 已是两阶段（静态先出、AI 后追加），但 AI 阶段仍 await 等待，未后台化。
3. **规则文档未内嵌进 Dashboard**：规则 Tab 只显示一句话 description，md 全文仍需打开文件看。如需内嵌，可在构建时把 9 份 md 编进 JSON（+约 15KB）。
4. **子 Workflow 列表不含入口文件**：Tab 语义为「子 Workflow」，入口风险在概览 KPI 与问题列表里。

---

## 七、commit 记录

| commit | 内容 |
|---|---|
| `docs(design): Analysis 报告与 Dashboard 优化可行性` | 参考实现机制分析 + 方案 |
| `docs(design): 补充规则文件化方案` | 一规则一文档 + 双向守卫 + 9 条清单 |
| `feat(analyzer): 规则文件化 P0-0` | 9 份 md + 守卫测试 |
| `fix(analyzer): AI Planner 超时根因是 prompt 形态` | 瘦身 + 超时 + 合并修复 |
| 本次 | Dashboard 生成器 + 模板 + 打开浏览器 + 接线 + 测试 |

---

## 八、引用

- 需求与方案：`dev-docs/design/2026-11-19-analysis-report-dashboard-feasibility.md`
- AI 超时诊断：`dev-docs/experience/ai-planner-timeout-prompt-shape.md`
- 参考实现：`thirdparties/PrdGameSkill/.claude/skills/game-prd-check/`（REF-016）
- 真实被测脚本：`thirdparties/PrdGameSkill/.opencode-workflows/workflows/game-requirement-audit/`
- 产物样例：`.pi/workflows/reports/dashboard/game-requirement-audit分析-Dashboard-20261119-01.html`
