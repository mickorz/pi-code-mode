# analyzer AI 探针（保留）

模型/超时相关诊断脚本。下次 provider 或档位变更时可直接复跑定超时值。

| 脚本 | 用途 |
| --- | --- |
| `probe.ts` | 分阶段打点：SettingsManager → loader → createAgentSession → prompt，定位慢在哪一步 |
| `bisect.ts` | prompt 变体二分（完整/指令头/输出约束），定位哪部分让模型零输出 |
| `fix-hypothesis.ts` | thinkingLevel 与输出格式的对照实验 |
| `final-prompt.ts` | 瘦身后 prompt 的稳定性验证 |
| `rate-limit-check.ts` | 冷却后重测，排除限流 |
| `real-cost.ts` | 真实 prompt 的实际耗时 |
| `models.ts` / `models2.ts` | 枚举可用 provider/model |
| `last-prompt.txt` | 一次真实 planner prompt 快照（实验输入） |

结论见 `dev-docs/experience/ai-planner-timeout-prompt-shape.md`。
