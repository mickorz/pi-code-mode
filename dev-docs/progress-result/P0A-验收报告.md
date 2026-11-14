# P0-A 验收报告（基础编排 MVP）

> 需求文档 R3 §8 MVP 门槛的 A 类验收。日期：2026-11-14。
> 验收脚本集：`dev-examples/sample-project-acceptance/A-basic/`（副本来源 submodule `7f6e93a`）。
> 执行方式：`run-acceptance.ts` 真实模型串行执行（pi SDK 1.3.0 + glm-5.3-flash），journal 落本仓库 `.journal/`（不污染 submodule）。

## 1. 验收结果：6/6 PASS

| # | 脚本 | 结果 | agents | 耗时 | 断言要点 |
|---|---|---|---|---|---|
| 1 | smoke-test.js | PASS | 3 | 9.9s | 1 发现 + 2 并行，results 长度 2 |
| 2 | chain-adapted-root.js（适配版） | PASS | 4 | 31.1s | 三层 `workflow()` 嵌套（root→middle→leaf×2），workflows invocation=4，prev 传递正确 |
| 3 | multi-tree-a.js | PASS | 4 | 14.9s | 3 并行 + 1 汇总，summary 非空 |
| 4 | multi-tree-b.js | PASS | 4 | 15.8s | 两轮 2 并行，round1/round2 各 2 |
| 5 | concurrency-limit-test.js（concurrency=8） | PASS | 24 | 10.8s | 24 探针全 ok，有效并发度≈4.7-7.2（区间断言 [3,13]） |
| 6 | acceptance-10docs.js | PASS | 12 | 88.4s | 1 发现 + 10 文档分析 + 1 汇总，总览 >2000 字符 |

重跑：`npx tsx dev-examples/sample-project-acceptance/run-acceptance.ts`

## 2. 验收中的发现与修正

1. **acceptance-10docs 断言两轮修正**：脚本实际结构为 1 发现 + 10 分析 + 1 汇总 = **12** agents（初版断言 11 漏算汇总节点）；文档分析节点的 label 由模型输出决定（`acp.mdx` 或 `docs/acp.mdx` 不稳定），断言改为按 `.mdx` 标签计数，与模型输出格式解耦。
2. **有效并发度测量噪声**：探针 durationMs 求和 / wall-clock 的测量方式受免费通道限流波动影响（两次实测 7.2 与 4.7，目标 8）。结论：信号量并发控制生效（24 探针无超限、无失败），精确并发度测量需更稳定的模型通道或 TUI 目测法（脚本注释读数法 3）。
3. **chain 系适配版通过**：`workflow()` 原语三层嵌套语义与 opencode 版一致（invocation 计数、args 传递、结果合并），适配决策（子会话不带工具、嵌套走原语）未破坏 A 类验收语义。

## 3. 与 MVP 门槛的差距

R3 §8 MVP = P0-A + P0-B。A 类已通过；**P0-B（native/composite 的非 race/fallback/resume 变体，约 14 个脚本）待验收**，此外 P0 范围内还有：

- `workflow_control` 工具（M1 仅 list/status/cancel）
- 跨 run 全局 Agent 并发闸（本轮 runWorkflow 直连未经过 RunManager 层）

## 4. 产物

- 验收 runner：`dev-examples/sample-project-acceptance/run-acceptance.ts`
- 脚本副本与分类：`dev-examples/sample-project-acceptance/`（8 类，61 + adapted 3 + runner + README）
- journal 审计留存：`dev-examples/sample-project-acceptance/.journal/`（不入库，见 .gitignore）
