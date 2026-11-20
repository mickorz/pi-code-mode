---
name: llm-must-use-model-tiers
description: 任何功能调用大模型必须走 .pi/workflows/model-tiers.json 的档位，档位选择需先问用户
type: feedback
---

# 大模型调用必须走 model-tiers.json

## 规则

本项目（pi-code-mode）**任何功能**（anal / workflow / 子代理 / 分析器 / 命令）只要调用大模型，**必须使用
`.pi/workflows/model-tiers.json` 中配置的档位**，禁止绕过。

1. **禁止依赖宿主默认模型**。不要写 `createPlannerAgent({ cwd })` 这种不指定模型的调用——它落到
   `~/.pi/agent/settings.json` 的 `defaultModel`，实测是 `glm-5.3-flash`（reasoning=true），
   单条规则检查要 97s，超时频发。
2. **禁止硬编码 provider/model**。模型串只能来自档位配置。
3. **档位选择必须先问用户**（`ask_user_question`），不要自行决定默认档位。
4. **解析不到档位必须告警**并回退会话默认，禁止静默回退。

## 标准实现

```ts
import { loadModelTiers } from "../engine/agent/model-tiers.js"

export function resolveTierModel(tier: string, cwd?: string): string | undefined {
  const tiers = loadModelTiers({ projectDir: cwd ?? process.cwd() })
  const entry = tiers[tier]
  return typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0]?.model : undefined
}
```

参考实现：`src/tools/workflow-analyze-tool.ts` 的 `resolveTierModel()` / `createPlannerAgent()`。
CLI 覆盖：`--tier <档位>` / `--model <供应商/模型>`。

## 实测依据

同一 prompt（REC-002 规则检查，20k 字符）：

| 模型来源 | 实际模型 | 耗时 | reasoning |
| --- | --- | ---: | --- |
| 宿主默认 | glm-5.3-flash | 97s | true |
| tiers.fast | deepseek-v4.1-flash-official | 14.1s | false |
| tiers.big | BF_ULTRA | 89.6s | false |

reasoning 模型做「读代码 + 输出结构化 JSON」慢 5~10 倍。

## 已确认决策（2026-11-19）

- `/workflows anal` AI 规则检查：**fast**
- `/workflows anal` AI 优化建议（Planner）：**fast**（与规则检查一致）
- 档位解析失败：**告警 + 回退会话默认**

见 `CLAUDE.md` 的「大模型调用规范（强制）」章节。
