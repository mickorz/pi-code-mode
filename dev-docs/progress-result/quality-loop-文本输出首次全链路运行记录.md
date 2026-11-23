# quality-loop 常规文本输出首次全链路运行记录

- 日期：2026-11-23
- runId：`run-1795417744826-w4x405`
- 触发方式：顶层命令 `/quality-loop <任务描述>`（自然语言参数，未传 `task=` / `tier=`）
- 任务：在 `dev-examples/` 下创建一个打印 hello world 的 demo.js
- 前置变更：本次运行是去掉 JSON schema 硬约束（commit `441479a`）后的首次完整闭环验证

## 1. 运行概览

| 项 | 值 |
| --- | --- |
| 拓扑 | coder → reviewer → judge（judge converged，fixer 未触发） |
| agent 数 | 3 |
| 阶段数 | 6 |
| 总耗时 | 102571ms（约 102.6s） |
| 终局 | `status=converged`，`roundsCompleted=1`，`repairs=[]` |

各角色耗时与 token：

| 角色 | 耗时 | token |
| --- | ---: | ---: |
| coder（fast） | 22.9s | 425 |
| reviewer（big） | 51.8s | 3060 |
| judge（big） | 27.7s | 2524 |

## 2. 与 schema 版对比

去掉 schema 硬约束后本轮**零修复循环**。对照此前 schema 版的表现：

| 场景 | schema 版 | 文本解析版（本次） |
| --- | --- | --- |
| reviewer 单跑 | 一次 schema 校验失败即多跑约 138s（修复循环） | 51.8s，一次通过 |
| quality-loop 全链 | 249s（含一轮修复回路） | 102.6s（且本轮无需修复） |

样本有限，不能下"必然更快"的结论，但"长尾延迟主要来自 schema 修复循环"的判断与本次观察一致。

## 3. 角色行为质量信号（真实工作，非走过场）

1. **reviewer 独立发现两条与任务无关的工作区问题**（不是复述 coder 自评）：
   - `dev-examples/builtin-roles-smoke/calc.js`、`calc-check.js` 存在之前联调遗留的 div 函数改动，若与 hello-world-demo 同批提交会混入无关内容；
   - `thirdparties/` 下 4 个 submodule（awesome-agent-clients、pi-memory、pi-model-router、pi-web-ui）工作树内容整体缺失（pi-memory 仅剩 1 个文件、25 条删除记录），疑似 workspace 同步未复制 submodule 内容。
2. **judge 逐条亲核**：亲自重跑 `node demo.js`（exit=0）、核对 `dev-examples/README.md` 约定、`git diff` 核实 calc 改动，最终裁定两条 findings 真实但属工作区既有状态、与本任务产物无关，降级为 info 保留，判 `converged`。
3. 这正是"独立评审 + 裁决核实"的设计意图：评审不照抄实施者自评，裁决不照抄评审结论。

## 4. 遗留给用户处理的事项（judge 的 info 级提醒）

1. `dev-examples/hello-world-demo/demo.js` 当前 untracked，是否入库由用户决定；
2. calc 两文件的联调改动与 hello-world-demo 分属不同任务，提交时分开处理（calc 改动可单独提交或还原）；
3. 四个 submodule 内容缺失，需要时执行 `git submodule update --init --recursive` 恢复；恢复前不要在这些目录内操作，也不要把 dirty 状态混入提交。

## 5. 文本解析路径的表现

- 三个角色一次通过，未出现「角色输出 JSON 解析失败 / status 非法」；
- 宽容提取（允许输出前后夹杂说明文字）在真实模型输出下工作正常；
- 引擎测试 222/222、contract 244/244 覆盖坏 JSON、非法 status、夹说明文字三类路径（见 `tests/engine/builtin-roles.test.ts`）。

## 证据

- journal：`.pi/workflows/journal/run-1795417744826-w4x405.json`（gitignore，不入库）
- 任务产物：`dev-examples/hello-world-demo/demo.js`
- 相关文档：[内置角色workflow-执行报告](../progress-result/内置角色workflow-执行报告.md)、[文本输出去 schema 化提交 441479a]
