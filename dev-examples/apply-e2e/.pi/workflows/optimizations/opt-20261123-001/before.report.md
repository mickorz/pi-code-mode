# Workflow Analysis: E:\WorkProjects\pi-code-mode\dev-examples\apply-e2e\worker.js

- analyzer 1.0.0 / ruleSet 1.0.0
- sourceHash: `sha256:da790bd1074e2e9a…`
- 入口风险: **2%**

> **关于「置信度」**：表示这条判断有多可信（0~1 之间，越大越可信）。≥0.85 确定、≥0.7 很可能、≥0.5 待确认（需人工判断）、**<0.5 仅提示（不计入风险分，只作检查线索）**。

## 调用结构

- 调用点: 1（agent 1 / workflow 0）
- 估算任务量: 1

## 检查清单（全部规则都执行过）

| 规则 | 严重度 | 静态 | AI 复核 | 最终 | 检查项 |
| --- | --- | --- | --- | --- | --- |
| `INPUT-001` | high | 通过 | 未启用 | pass | 同一个输入对象被多次注入不同 agent → 重复序列化与 token 浪费 |
| `CONC-001` | medium | 通过 | 未启用 | pass | 并行任务数超过并发上限 → 多波次执行（要求任务数静态可确定） |
| `CONC-002` | medium | 通过 | pass（确定） | pass | 并行任务数是运行时动态决定的分片（静态不可知，需人工确认分片数/并发/超时） |
| `SERIAL-001` | low | 通过 | 未启用 | pass | 多个 agent 构成明确数据依赖链（合理串行，但可能是墙钟瓶颈） |
| `SERIAL-002` | medium | 通过 | pass（确定） | pass | 源码相邻但无数据引用的 agent 调用 → 可并行候选（需语义确认） |
| `TIMEOUT-001` | medium | 通过 | 未启用 | pass | agent 调用缺少 timeoutMs 且无 run 级超时 → 单点挂起会拖垮整阶段 |
| `RETRY-001` | low | 命中 1 | 未启用 | static-hit | retries 放大失败场景下的调用量与 token 消耗 |
| `DET-001` | low | 通过 | pass（确定） | pass | prompt 语义看起来可用确定性 JS 完成（统计/校验），交给 LLM 是浪费 |
| `REC-001` | high | 通过 | 未启用 | pass | 大规模任务且无 phase 边界 → 失败后只能整 run 重跑 |
| `REC-002` | high | 静态不判定（由 AI 检查） | pass（确定） | pass | 恢复模式（retry/resume/from-stage）读取的收窄集合没有沿调用链传给下游 workflow → 恢复退化为全量重跑 |
| `IO-001` | medium | 通过 | 未启用 | pass | agent prompt 要求用 read/write 工具处理文件 → 确定性 IO 走了模型往返 |
| `INPUT-002` | medium | 通过 | 未启用 | pass | 阶段起点分支要求了该阶段并不需要的输入 → 阶段级恢复被无关输入阻断 |
| `BUDGET-001` | high | 静态不判定（由 AI 检查） | pass（确定） | pass | 入口并行调度子 workflow，子流程内部又动态并行，但并发预算未显式切分 → 实际在途数可能翻倍 |
| `SIDEFX-001` | high | 静态不判定（由 AI 检查） | not-applicable（确定） | pass | SERIAL-002 报出的并行候选实际通过文件路径或共享状态存在隐式依赖 → 不能并行化 |

## AI 规则检查（completed / 77s）

- 命中 0 / 待确认 0 / 通过 6 / 失败 0（共 6 条）


## 发现的问题（1 条 → 1 个问题簇）

### 1. RETRY-001

- 严重度: low / 置信度: 0.80（很可能） — 依据较强，核对一眼后改
- 涉及文件: E:\WorkProjects\pi-code-mode\dev-examples\apply-e2e\worker.js
- 位置: E:\WorkProjects\pi-code-mode\dev-examples\apply-e2e\worker.js:L14-14

- retries 最高 2 次
- agent 调用点 1 个
- 失败场景最坏调用量 ≈ 3

代表代码：
```js
const r = await agent(`只回复数字 ${n}`, { timeoutMs: 60000, retries: 2 })
```

**建议**：全量失败时重试会造成成倍 token 消耗，配合 M3 任务级恢复只重跑失败任务

## 优化建议

### OPT-001 全量失败时重试会造成成倍 token 消耗，配合 M3 任务级恢复只重跑失败任务
- 严重度: low / 质量风险: low
- 预期收益: 待 Benchmark 验证（静态估算不提供数值收益）
- 验证条件: 重新运行 Analyzer 确认风险消除；Benchmark 对比耗时与 Token 不劣化
