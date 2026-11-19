# Analyzer 只分析单文件：嵌套子 workflow 全部漏检

- 日期：2026-11-19
- 触发：用 `thirdparties/PrdGameSkill` 真实场景验收
- 影响面：所有「壳 + 子流程」结构的生产 workflow（这是多阶段编排的标准形态）

---

## 问题现象

`/workflows analyze .opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js` 报告：

```
风险分 2/100
调用点 5（agent 2 / workflow 3）
[LOW] RETRY-001
```

看起来"这个 workflow 很干净"。

**但真实情况**：

| 文件 | 行数 |
| --- | --- |
| game-requirement-audit.js（入口，被分析） | 714 |
| 11 个兄弟子流程（S1~S11，未被分析） | 2799 |
| 合计 | **3513** |

入口只是编排壳（`workflow({ scriptPath: STEPS[i].script })`），真正的业务逻辑、prompt 设计、并发结构全在子流程里。
**只分析入口 = 只检查了 20% 的代码，却给出"风险 2/100"的结论。**

## 排查过程

1. 用户指出"没分析出问题，里面有 11 个子 workflow"。
2. 检查 `analyzeWorkflow`：只 `readFileSync(file)` 一个文件 → `buildReport`，没有任何跨文件逻辑。
3. 检查 `ast-parser` 的 `scriptPath` 提取：只处理 `workflow('./literal.js')`，而真实写法是
   `workflow({ scriptPath: def.script })`（路径来自 STEPS 数组变量）→ 即使想递归也拿不到路径。
4. 手动扫同目录 12 个文件：合计 49 个调用点、risk 合计 49。**覆盖率差距 10 倍**。

## 根因

Analyzer 的设计假设是「一个 workflow = 一个文件」，与真实工程形态不符：

- 多阶段编排天然拆成「主编排 + 每阶段一个子流程」（workflow-authoring skill 自己就推荐这种拆分）
- 子流程路径常来自配置数组（`STEPS[i].script`）而非字面量，静态解析不可靠

## 解决方案

新增 `src/engine/analyzer/tree-analyzer.ts`，两层聚合（保守、不猜测）：

1. **同目录兄弟脚本**：入口所在目录内、源码含 `export const meta =` 的 `.js` 视为子 workflow。
   —— 不依赖路径解析，正好匹配「子流程与主编排同目录」的拆分约定。
2. **子目录递归**：从源码提取 `'./x/y.js'` 类字面量，存在则递归（`realpath` 去重防环 + 深度上限 2）。

聚合口径（关键取舍）：

- **`maxRisk` 取最危险单文件，不做求和**——求和会让 risk 虚高到 100，失去区分度。
- 另给 `files` / `callSites` / `totalFindings` / `rules` 分布，让"覆盖了多少"可见。
- 明确标注：「只做结构级聚合，不做跨文件变量级数据流分析」（架构基线陷阱 2：不猜测）。

报告与命令输出：

```
风险分 2/100
调用点 5（估算任务 4，含动态为下限） · 动态节点 5
跨文件聚合：12 个文件 · 40 个调用点 · 21 条 finding · 最高风险 7/100（1-scan-template.js）
```

报告 Markdown 增加「子 Workflow」表格（每文件 risk / 调用点 / finding / 主要规则）。

## 修复后事实

PrdGameSkill `game-requirement-audit/` 目录聚合结果：

| 指标 | 修复前（仅入口） | 修复后（聚合） |
| --- | --- | --- |
| 覆盖文件 | 1 | **12** |
| 调用点 | 5 | **40** |
| finding | 1 | **21** |
| 规则分布 | RETRY-001×1 | RETRY-001×12 + SERIAL-002×9 |

**结论**：这些脚本本身质量不错（最高风险 7/100），所以"低风险"的最终判断没变——但**依据从"看了 714 行"变成"看了 3513 行"**。这才是可信的结论。

## 教训

1. **分析类工具的默认行为必须匹配真实工程形态**。单文件分析对"单文件项目"够用，但多阶段编排是主流写法，漏掉子流程等于漏掉主要代码。
2. **不要依赖路径字面量做跨文件分析**。真实脚本用配置数组传路径；「同目录 + 含 meta」是更鲁棒的启发式。
3. **聚合口径要保守可解释**。风险分求和会饱和成 100 失去意义，取 max + 展示覆盖范围更诚实。
4. **"入口干净" ≠ "系统干净"**。这条已固化为测试用例：入口 0 finding、子流程有 INPUT-001 时，聚合必须报出来。
5. 用户比我更了解被测对象——他一句"里面有 11 个子 workflow"直接指出了覆盖缺口。**真实场景验收必须由熟悉该场景的人确认覆盖范围**。

## 相关

- 实现：`src/engine/analyzer/tree-analyzer.ts`
- 测试：`tests/analyzer/tree-analyzer.test.ts`（7 条，含"入口干净子流程脏"用例）
- 同类问题：`dev-docs/experience/analyzer-input-001-false-positives.md`（误报）、
  `dev-docs/experience/analyze-timeout-not-consumed.md`（死配置）
