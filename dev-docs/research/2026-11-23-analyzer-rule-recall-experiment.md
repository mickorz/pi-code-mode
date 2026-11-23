# Analyzer 规则召回实验（缺陷 demo）

- 日期：2026-11-23
- 目的：用**故意写坏的** workflow 验证 `/workflows anal` 的规则召回率，而不是只看"好脚本 0 风险"
- 被测对象：`dev-examples/min-workflow/buggy-demo.js`
- 驱动：`dev-examples/buggy-anal.ts`

---

## 一、缺陷清单与预期

脚本里刻意埋了 8 类缺陷：

| 规则 | 埋点 | 预期 |
| --- | --- | --- |
| `TIMEOUT-001` | 所有 `agent()` 都不写 `timeoutMs`，也无 run 级超时 | 命中 |
| `RETRY-001` | `retries: 2` | 命中 |
| `INPUT-001` | `allRequirements` 以 `JSON.stringify` 整体注入 2 个 agent | 命中 |
| `SERIAL-002` | `buggyA` / `buggyB` 相邻、互不引用 | 命中 |
| `CONC-002` | `parallel(parts.map(...))`，`parts` 来自运行时 `args` | 命中 |
| `DET-001` | prompt 是「统计 items 的数量并去重」 | 命中 |
| `IO-001` | prompt 要求模型「用 read 工具读取文件」 | 命中 |
| `REC-001` | 总任务量 ≈ 48 + 4 = 52 ≥ 20，且全文无 `phase()` | **预期命中** |

---

## 二、实测结果：7 / 8

```text
=== 静态规则命中（14 条全量）===
  INPUT-001    命中 2
  CONC-001     通过
  CONC-002     命中 4
  SERIAL-001   通过
  SERIAL-002   命中 2
  TIMEOUT-001  命中 2
  RETRY-001    命中 2
  DET-001      命中 2
  REC-001      ❌ 通过（漏报）
  REC-002      ai-only
  IO-001       命中 2
  INPUT-002    通过
  BUDGET-001   ai-only
  SIDEFX-001   ai-only

风险分 23/100 | findings 8 | 问题簇 7
```

> 注：规则清单的 hits 与问题簇的 count 不同，是因为部分规则的 finding 会被合并进同一簇（如 CONC-002 命中 4 处 → 1 个簇含 2 处位置 + 另 2 处归并）。

### 问题簇明细

```text
CONC-002 ×2   medium conf=0.40  L8-8 / L32-32   并行任务数来自运行时集合 `parts`（map），静态不可知
INPUT-001 ×1  medium conf=0.85  L49-50          标识符 `allRequirements` 在 2 个调用中出现（行 49, 50）
SERIAL-002 ×1 medium conf=0.70  L43-50          4 个调用源码相邻但无数据引用（call-3..call-6）
TIMEOUT-001 ×1 medium conf=0.75 L34-36          5 个 agent 调用均未声明 timeoutMs，且无 run 级超时
DET-001 ×1    low    conf=0.50  L43-43          prompt 语义疑似确定性任务：统计 items 的数量并去重
IO-001 ×1     low    conf=0.80  L46-46          1 处 agent 调用把确定性文件 IO 交给模型（行 46）
RETRY-001 ×1  low    conf=0.80  L34-36          retries 最高 2 次
```

---

## 三、漏报分析：REC-001 为什么没抓到

**根因**：`estimateTaskCount()` 对动态分片只记 1。

```ts
// src/engine/analyzer/rules/index.ts
const max = n.loopBounds?.max
if (max !== undefined) total += max
else if (!n.dynamic) total += 1
else { determined = false; total += 1 }   // ← 动态分片也算 1
```

`parallel(parts.map(...))` 里只有一个 `agent` 节点，`parts` 来自 `A.parts`（运行时）→ 该节点记 1。
总数 = 1 + 4 = 5 < 20 → REC-001 不命中。

**这是设计边界，不是 bug**：静态拿不到分片数，就无法判断"是否大规模任务"。硬要给结论只能靠猜。

**信息没有真正丢失**：同一个盲区由 `CONC-002` 覆盖——它明确提示「分片数静态不可知，需人工确认分片数/并发/超时」，并列出 48 分片这个声明值。

已把这条写进 `09-REC-001-rule.md` 的「已知误报与局限」：

> **动态分片不计入规模**（实测确认）：`parallel(parts.map(...))` 里 parts 来自运行时，
> `estimateTaskCount` 只把该 agent 记为 1，所以 48 个分片会被当成 1 个任务 → `total < 20` → 本条**漏报**。

---

## 四、AI 规则复核（big 档，246s）

```text
AI status: completed | 耗时 246s
  CONC-002     hit    conf=0.95  ev=2
  SERIAL-002   hit    conf=0.70  ev=3
  DET-001      hit    conf=1.00  ev=1
  REC-002      pass   conf=0.95
  BUDGET-001   pass   conf=0.95
  SIDEFX-001   pass   conf=0.90
```

### AI 补充了静态看不到的语义

**CONC-002**：

> `parallel()` 的第一个参数是 `parts.map(...)`（行 32-33），而 `parts` 声明为
> `A.parts || Array.from({ length: 48 }, ...)`（行 28），**分片数被运行时 args 覆盖**，
> 声明处不是可静态定长的字面量，命中判定口径

静态只能说"集合不可知"，AI 指出**为什么会不可知**（三元表达式有 args 分支）。

**SERIAL-002**：

> 4 个 agent 调用源码相邻（中间仅空行与注释），且彼此无数据引用……
> **风险说明：first 与 second 均引用同一外部输入 allRequirements**
> （外部常量而非任一调用输出）

这条很关键——它区分了"共享外部常量"（不是数据依赖，可并行）与"引用彼此输出"（真依赖）。

**DET-001**：

> prompt 以「统计」开头且同时含「去重」关键词组……纯确定性统计任务交给了 LLM；
> 第二个关键词组（校验/核对格式）无命中。按「每组最多报一条」口径，报告 1 条 evidence

AI 还主动说明了"为什么不报两条"（规则的组内取首条口径）。

### 三条 aiOnly 规则判 pass 是正确的

脚本里没有 `mode=retry` 分支（REC-002 不适用）、没有双层 `parallel(workflow)` 嵌套（BUDGET-001 不适用）、相邻调用都只读不写（SIDEFX-001 不适用）。

---

## 五、本次实验发现的第二个问题：Planner JSON 容错不足

```text
AI 建议未生成：AI 建议校验失败：JSON 解析失败：
Expected ',' or ']' after array element in JSON at position 722 (line 1 column 723)
```

模型输出的 JSON 在 722 字符处不合法（可能被截断或引号未转义）。当前 `parsePlannerResponse` 是**严格 `JSON.parse`**，一次失败就整条丢弃。

不影响静态与 AI 规则检查（它们各自独立），但意味着**Planner 建议会随机丢失**。

建议后续改进（未做）：

1. 截断感知：JSON 不完整时尝试闭合括号后重试解析
2. 或降低 Planner 输出长度要求（现在要求多个字段的 proposals 数组）
3. 或对解析失败重试一次（同档）

---

## 六、结论

| 指标 | 结果 |
| --- | --- |
| 静态规则召回 | **7 / 8**（REC-001 因动态分片漏报，有 CONC-002 兜底） |
| AI 规则复核 | 6 条全部出结论，3 命中 / 3 通过，**判定全部正确** |
| 风险分 | 23/100（一个有 8 类缺陷的脚本，分数仍不高——因为多数是 low/medium 且置信度中等） |
| 问题簇 | 7 个（同类合并生效） |
| Dashboard | 正常生成 |

**这次实验的价值**：

1. 证明规则不是"摆设"——故意埋的缺陷基本都能抓到
2. 找到 REC-001 的真实漏报边界，并写进规则文档
3. 找到 Planner JSON 容错不足，作为已知问题记录
4. AI 复核确实提供了静态拿不到的语义（分片数为何不可知、共享外部常量 vs 数据依赖）

---

## 七、复现方法

```bash
# 静态（几秒）
npx tsx dev-examples/buggy-anal.ts

# 含 AI 规则复核（约 4 分钟）
npx tsx dev-examples/buggy-anal.ts --with-ai

# 或在 pi 会话里
/workflows anal dev-examples/min-workflow/buggy-demo.js --no-rule-check --no-open
/workflows anal dev-examples/min-workflow/buggy-demo.js --no-open
```

产物：

```text
.pi/workflows/reports/buggy-demo.analysis.md
.pi/workflows/reports/buggy-demo.analysis.json
.pi/workflows/reports/dashboard/buggy-demo分析-Dashboard-*.html
```

---

## 引用

- 缺陷脚本：`dev-examples/min-workflow/buggy-demo.js`
- 驱动：`dev-examples/buggy-anal.ts`
- 规则实现：`src/engine/analyzer/rules/index.ts`
- 规则文档：`src/engine/analyzer/rules/definitions/`（REC-001 局限已更新）
- 任务量估算：`src/engine/analyzer/rules/index.ts` 的 `estimateTaskCount()`
- AI 规则检查：`src/engine/analyzer/ai-rule-checker/`
- 正常脚本对照：`dev-docs/guides/workflow-js-testing-guide.md`
