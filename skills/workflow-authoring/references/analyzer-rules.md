# Analyzer 规则参考

`workflow_analyze` 工具的规则清单与解读方法。所有 rule 都带 `confidence`（0-1）——**低置信度结论不得作为自动修改依据**。

## 规则清单

| Rule ID | 严重度 | 检测内容 | 典型置信度 |
| --- | --- | --- | --- |
| `INPUT-001` | high/medium | 同一标识符被多个 agent/workflow 注入（含 `JSON.stringify` 整体序列化） | 0.6-0.85 |
| `CONC-001` | medium | 并行任务数 > 并发上限 → 多波次 | 0.5-0.9（含动态节点时降级） |
| `SERIAL-001` | low | ≥3 个调用构成 Explicit 数据依赖链 | 0.95 |
| `SERIAL-002` | medium | 源码相邻但无引用的并行候选 | 0.4-0.7（**需语义确认**） |
| `TIMEOUT-001` | medium | agent 调用无 timeoutMs 且无 run 级超时 | 0.75 |
| `RETRY-001` | low | retries ≥2 时的最坏调用量放大 | 0.8 |
| `DET-001` | low | prompt 语义疑似确定性任务（统计/校验可 JS 化） | 0.5 |
| `REC-001` | high | ≥20 调用点且无 phase 边界（失败恢复成本高） | 0.7 |

## 依赖置信度（决定能不能并行化）

| 置信度 | 含义 | 可否据此并行化 |
| --- | --- | --- |
| `Explicit` | 后调用引用了前调用的结果 | ❌ 真依赖，不可并行 |
| `Structural` | 同容器（parallel/sequence）内的结构归属 | 需看容器语义 |
| `Candidate` | 相邻但无数据引用 | ⚠️ **必须语义确认**后才可 |
| `Unknown` | 动态循环/动态分发，静态不可判定 | ❌ 禁止自动采纳 |

**动态代码边界**：`for (const x of tasks) await agent(...)` 只输出「动态节点 + 可确定上下界」；`handlers[type](input)` 标 Unknown。Analyzer 不伪造调用次数。

## 怎么读报告

```
# 会话内命令（唯一手动入口，AI 建议默认开启）
/workflows analyze .pi/workflows/demo.js

# 等价工具（Agent 自动调用时用）
workflow_analyze({ scriptPath: ".pi/workflows/demo.js" })
```

关键字段：

- `summary.riskScore`（0-100）：只统计 confidence ≥ 0.5 的 finding
- `executionEstimate.determined`：`false` 表示含动态节点，任务量是**下限估算**
- `dependencies.unknowns`：静态不可判定项，禁止据此自动并行化
- `recommendations[].expectedImpact`：静态分析**永远不提供数值收益**，一律「待 Benchmark」

## 优化建议的应用边界（强制）

Analyzer 提出建议 ≠ 可以直接改代码。任何修改走六步链：

```
Analyzer 分析 → 生成 Optimization Suggestions → Agent 在独立工作区修改
→ 重新 Analyzer + Benchmark → 用户确认 → 应用修改
```

生产 Workflow（如 PrdGameSkill）额外要求：修改后需求覆盖检查、证据映射、最终质量验证**必须仍然全部执行**——不能因为 Analyzer 认为「可以合并任务」就直接改生产脚本。

## 扩展规则

规则实现统一接口（`src/engine/analyzer/types.ts`）：

```ts
interface AnalyzerRule {
  id: string
  version: string
  severity: "critical" | "high" | "medium" | "low"
  analyze(context: AnalyzerContext): AnalyzerFinding[]
}
```

新增规则加入 `src/engine/analyzer/rules/index.ts` 的 `BUILTIN_RULES` 即可，无需改动 Analyzer 主体。规则抛错会被隔离（记 confidence=0 的提示，不影响其他规则）。
