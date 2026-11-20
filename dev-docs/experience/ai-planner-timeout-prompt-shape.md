# AI Planner 调用超时的真实根因：prompt 形态，不是 provider

- 日期：2026-11-19
- 现象：`/workflows analyze` 默认开启的 AI 建议**每次**都失败，diagnostic 只有一行「AI 建议调用失败：Planner 调用超时（60000ms）」。上一轮排查结论是「provider/credentials 在子 session 未继承」——**这个结论是错的**。
- 结论：认证与 provider 完全正常；根因是 **planner prompt 的形态**（4000 字符源码 + TS schema 描述）让 `glm-5.3-flash` 长时间零输出（120~260s 无任何 delta），60s 默认超时必然打穿。

## 一、排查过程（先证伪，再定位）

### 1. 证伪"认证未继承"

探针 `dev-examples/analyzer-ai-probe/probe.ts` 分阶段打点：

| 阶段 | 耗时 | 结果 |
|---|---|---|
| `SettingsManager.create` | 10ms | `defaultProvider=cc-switch-zhipu-glm` / `defaultModel=glm-5.3-flash` 都读到了 |
| `loader.reload({noExtensions:true})` | 221ms | 正常 |
| `createAgentSession` | 416ms | model 对象含 baseUrl、reasoning:true |
| `session.prompt("只回复 ok")` | **1.8s** | 正常返回 |

→ 认证继承没有任何问题。**6 字符 prompt 1.8 秒返回**，直接推翻了 provider 假设。

### 2. 用真实 prompt 复现

把 `buildPlannerPrompt` 的真实产物（5126 字符）喂给同一个 session：

| prompt | 耗时 | 输出 |
|---|---|---|
| 6 字符 `只回复 ok` | 1.8s | 2 字 |
| 40k 字符填充文本 | 16.8s | 正常 |
| **真实 planner prompt 5126 字符** | **120s 无返回** | **0 字** |
| 同上，放宽到 260s | **260s 无返回** | 0 字 |

关键：**`agent_start` 事件在 4ms 就到了，之后 120 秒零 delta、零 thinking**。abort 时才收到一条 `chars=0` 的 message_end。

### 3. 排除限流与 thinking 等级

- **限流**：冷却 90s 后再测，同一窗口内「只回复 ok」1.6s 正常、224 字符 JSON 约束 70s 零响应 → 不是限流。
- **thinkingLevel**：`thinking=low` 反而更慢（54s vs 16s），不是解药。
- 对照组始终正常，证明服务本身健康。

### 4. 二分定位到 prompt 形态

| 变体 | 结果 |
|---|---|
| 指令头前 80 字符 | 20.3s，595 字 ✅ |
| 指令头全文 326 字符 | 43.9s，865 字 ✅ |
| 指令头 + `{analysisSummary: string, proposals: [{...codeSketch?...}]}` schema 描述 | **45s 超时，0 字** ❌ |
| 去代码片段但仍含 schema 描述的完整 prompt | 60s 超时 ❌ |

两个触发源：
1. **4000 字符真实源码片段**（`## 相关代码片段`）
2. **TS 风格的 schema 描述**（`{ analysisSummary: string, proposals: [...] }`）——224 个字符就能让服务端零输出

## 二、根因

`glm-5.3-flash` 是 **reasoning 模型**（`reasoning: true`，当前唯一可用的 zhipu 模型，另一个 `glm-5.3` 同样）。面对「读 4000 行源码 + 按 TS schema 输出嵌套 JSON」这类请求，它会进入长时间无输出的状态——**不是慢，是连第一个 token 都不发**。

而给它**照抄格式的 JSON 示例**（而不是 schema 类型描述）+ **不含源码的结构摘要**，同样的任务 63~71s 就能稳定返回。

## 三、解决方案（已实施）

### 1. `buildPlannerPrompt` 瘦身（5126 → 1159 字符）

| 改动 | 原因 |
|---|---|
| **删掉源码片段段**（`## 相关代码片段`） | 4000 字符真实代码是最大负担；模型只看结构摘要就能给建议 |
| findings 一行一条（evidence 用「；」合并） | 嵌套列表把 prompt 撑大 |
| **TS schema 描述 → JSON 示例**（`## 输出格式（照抄这个结构）`） | schema 形态会触发零输出 |
| 加「最多 3 条建议」约束 | 限制输出长度，缩短生成时间 |

### 2. 默认超时 60s → 240s

实测瘦身后耗时 63~145s（模型输出长度波动大）。240s 给 1.6 倍余量。

### 3. 修 `mergeRecommendations` 丢弃 AI 建议的 bug

旧实现：

```ts
const dup = out.find((r) => r.title === p.title || r.ruleIds.some((id) => p.problem.includes(id)))
if (dup) continue   // ← AI 精心写的行动方案/依赖分析被整条扔掉
```

静态建议的 `ruleIds` = `["SERIAL-002"]`，AI 建议的 `problem` 里必然提到 `SERIAL-002` → 判定重复 → 丢弃。**AI 检查的价值被完全抵消**，用户看到的仍是一行静态模板文案。

改为：
- 同源（静态 ruleId 出现在 AI problem 里）→ **替换**该条（保留静态 id 与 ruleIds，内容换 AI 详细版）
- 不同源 → 追加，**id 冲突时重新分配**（AI 也从 OPT-001 起编号，必然撞号）
- 所有 AI 来源的建议标 `source: "ai"`，报告渲染为 `[AI]`

## 四、效果（真实场景实测）

`thirdparties/PrdGameSkill` 的 `4-client-verify.js`：

| | 修复前 | 修复后 |
|---|---|---|
| prompt | 5126 字符 | 1159 字符 |
| 超时 | 180s 全失败 | 0 次失败 |
| 耗时 | ≥180s（超时） | 68s / 84s / 145s |
| AI 建议 | 0 条（全丢弃） | 2~3 条，含具体行动方案与依赖分析 |

AI 实际输出示例（节选）：

> `{"analysisSummary":"4-client-verify.js 共 7 个 agent 调用点：两段串行组（L301-364、L379-412）静态无数据引用但均含动态/Explicit 依赖节点，需语义确认后才可并行；统一重试策略（retries≤2）使最坏调用量达约 21..."}`

正确标注了「需语义确认」「待 Benchmark」，没有虚构数值。

## 五、预防 / 注意事项

1. **给 reasoning 模型的 prompt，输出格式一律用「可照抄的 JSON 示例」，不要用 TS/JSON-Schema 类型描述**。这是本次最反直觉的发现：224 字符的 schema 描述比 40k 字符填充文本更能让服务端零输出。
2. **不要往 planner prompt 里塞源码**。结构摘要（风险分/调用点/一行一条 finding）足够支撑建议；要看代码的场景应该走带工具的子代理，而不是一次性 prompt。
3. **超时值必须有实测依据**，不能拍 60s。实测区间 63~145s，取 240s。
4. **凡是"AI 建议与静态建议合并"的逻辑，务必测"AI 建议是否真的出现在最终结果里"**。`if (dup) continue` 这种写法会让 AI 的产出静默消失，而 diagnostics 是空的（因为调用成功了），极难发现。
5. **AI 与静态建议的 id 空间必须分开**。两边都从 OPT-001 起编号，不测撞号就会出现两条 OPT-001。
6. 探针脚本保留在 `dev-examples/analyzer-ai-probe/`（probe / bisect / fix-hypothesis / lean / see-output / rate-limit-check / final-prompt），下次模型或 provider 变更时可直接复跑定超时。

## 六、未解决的问题

- 耗时仍在 63~145s 波动，用户需等待 1~2.5 分钟。根本原因是 zhipu 只有 reasoning 模型可用；若后续能接入非 reasoning 模型（gpt-4o-mini 类），建议 `analyze` 用轻模型跑 AI 建议。
- `analyze` CLI 已是两阶段输出（静态先出、AI 后追加），但 AI 阶段仍是阻塞等待，没有后台化。

## 引用

- 探针：`dev-examples/analyzer-ai-probe/probe.ts`、`bisect.ts`、`fix-hypothesis.ts`、`lean.ts`、`see-output.ts`、`rate-limit-check.ts`、`final-prompt.ts`
- 实现：`src/engine/analyzer/optimization-planner.ts`（`buildPlannerPrompt` / `mergeRecommendations`）、`src/tools/workflow-analyze-tool.ts`（`createPlannerAgent`）
- 测试：`tests/analyzer/optimization-planner.test.ts`（11 用例，含 prompt 体积守卫 < 1500 字符、AI 建议不丢弃、id 不撞号）
- 相关经验：`dev-docs/experience/analyze-timeout-not-consumed.md`（另一个超时陷阱：`AgentRequest.timeoutMs` 是死字段，只 `signal` 生效）
