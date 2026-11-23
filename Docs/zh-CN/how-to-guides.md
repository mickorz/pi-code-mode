# 操作指南

> 面向任务：一个场景一节，步骤化。随功能实现逐步补充。

## 直接用内置角色工作流（改代码 / 评审 / 裁决 / 修复 / 质量闭环）

内置 `coder` / `reviewer` / `judge` / `fixer` / `quality-loop` 五个工作流，用法、参数、档位与排错见 [内置角色工作流使用指南](builtin-workflows.md)。

这五个是**内置**的（随包分发），装上插件即生效、无需注册，而且直接说人话即可：`/coder 修复登录超时`、`/quality-loop 实现 xx 功能`（档位用缺省值，不用传 `tier=`）。项目自有工作流才需要 `/workflows register <脚本路径>`。

## 写一个 workflow 脚本

1. 在项目根建 `.pi/workflows/my-flow.js`（或放子目录用路径引用）。
2. 首条语句导出 `meta`（name 为 snake_case，必填 description）。
3. 脚本体用编排原语：`agent(prompt, opts)` / `parallel` / `pipeline` / `phase` / `log`，显式 `return` 结果。
4. 加载方式二选一：注册表按名引用（一级目录脚本），或 `workflow` 工具传 `scriptPath` 直接执行。

约束：脚本内禁 import/require、禁 `Math.random`/`Date.now`（沙箱会中和）、至少调用一次 `agent()`。

## 后台运行与控制

1. `workflow` 工具传 `background: true` 提交，立即返回 runId。
2. 用 `workflow_control` 工具 stop/pause/resume。
3. run 完成后结果自动回传主会话。

## 断点续跑（resume）

1. 首跑记下输出中的 runId。
2. 修改脚本后用 `resumeFromRunId` 重跑：最长未变前缀从 journal 回放（零 token），只有变化的节点真正执行。
3. 参考样例：`scripts/resume-test.js`（两步法）。

## 定时调度（P2 规划）

自然语言描述定时需求 → `/schedule` → cron 表达式 → `schedule_create`。注意：pi 进程关闭期间不执行，错过不补跑。
