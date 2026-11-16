# TUI 能力对比：pi-code-mode vs pi-dynamic-workflows

> 对比日期：2026-11-16
> 对比对象：本仓库（pi-code-mode，自研插件）vs `thirdparties/pi-dynamic-workflows`（参考项目，只读）
> 方法：CodeGraph 符号级探查（workflow-ui / workflow-progress / display / workflow-editor / workflow-commands / run-persistence）+ 本仓库源码盘点

## 0. 定位差异（对比前提）

| | pi-dynamic-workflows | pi-code-mode（本仓库） |
|---|---|---|
| 核心范式 | **LLM 动态生成闭环**：自然语言 prompt → 主代理现场生成 workflow 脚本 → 执行（关键词武装 / effort 强化） | **确定性脚本编排**：预制 JS DSL 脚本 → 引擎按 journal 确定性执行/重放 |
| `/workflows run` 语义 | `run <自然语言描述>`，组装 forcing directive 后 `sendMessage(triggerTurn)` 让模型生成并执行 | `run <脚本路径或注册表 id>`，直接执行脚本 |
| 持久化 | run-persistence（PersistedRunState 快照、pause/resume、exportResult） | journal 逐节点落盘 + resumeFromRunId 零成本前缀回放 |

**结论先行**：两边不是同一范式，TUI 差距要分"值得追"与"不该追"两类。凡服务于"动态生成闭环"的能力（关键词武装、effort、ultracode、内置工作流命令族）不属于本仓库目标，不建议追；凡服务于"运行可观测性"的能力（事件驱动 widget、watch 状态行、富结果回传、navigator）是纯体验增强，值得吸收。

## 1. 能力矩阵总览

| # | TUI 能力 | pi-dynamic-workflows | pi-code-mode | 差距评级 |
|---|----------|---------------------|--------------|----------|
| 1 | `/workflows` 裸命令 | 打开 **Navigator 全屏交互面板** | 输出文本帮助面板 | **大**（体验代差） |
| 2 | 交互式 Navigator | overlay 面板（94% 宽/92% 高、右侧边栏锚点、browse/filter/rename/confirm 四态、runs 列表/详情钻取/已保存工作流视图、markdown 渲染、翻页、主题着色） | 无 | **大** |
| 3 | 进度 widget | 事件驱动（agentStart/agentEnd/phase/log/tokenUsage 事件 → 节流发布管线 + 微任务急行道），支持 compact/detailed 面板模式与 maxAgents 截断（设置持久化） | 2s `setInterval` 轮询 `runManager.list()`，单行 `label done/nodes` | **中**（机制代差：轮询 vs 事件） |
| 4 | watch 状态行 | `ctx.ui.setStatus` 逐事件刷新单行进度，完成自动清理并回传结果 | 无 | **中** |
| 5 | 结果回传 | `sendMessage({ customType: "workflows", display: true })` 自定义消息类型（宿主可注册专属渲染器） | `pi.sendUserMessage(纯文本)` | **小**（可等价，富渲染欠缺） |
| 6 | 后台启动提示 | mode 感知（TUI → "watch the task panel"；非 TUI → 提示用 status 命令） | 固定文案（立返 runId + 用法提示） | 相当 |
| 7 | pause/resume 命令 | `pause` / `resume`（快照持久化，WorkflowResumeMode） | 无 pause；`stop` + `resumeFromRunId` journal 回放替代 | 设计差异（见 §3.7） |
| 8 | 删除运行 `rm` | 有（含确认流程） | 无（journal 一律保留） | 小 |
| 9 | 工作流管理形态 | 每个已保存工作流注册为**独立斜杠命令**（参数 schema、位置参数解析、saved > builtin 遮蔽优先级） | 集中式 manifest（`.pi/workflows/register.json`）+ `/workflows run <id>` | 设计差异（见 §3.9） |
| 10 | 内置工作流命令族 | deep-research / adversarial-review / code-review / multi-perspective / codebase-audit | 无（不同定位，不需要） | 不追 |
| 11 | 关键词武装 / effort / ultracode 模式 | 有（服务于动态生成闭环） | 无（workflow-authoring skill 覆盖生成指导） | 不追 |
| 12 | 模型分层查看 | `/workflows-models` 命令 | model-tiers.json 配置 + resolveTier，无查看命令 | 小 |
| 13 | checkpoint 确认 | navigator confirm 体系内 | `ctx.ui.confirm` 对话框 | 相当 |
| 14 | 定时调度 | **无** | schedule_* 工具族 ×8 + ScheduleRuntime + `/schedule` | **本仓库独有** |
| 15 | 显式注册/注销指令 | 无（save 即注册为命令） | `register|reg` / `unregister|unreg`（manifest 排他制） | **本仓库独有** |
| 16 | 运行持久化与重放 | PersistedRunState 快照（preview/exportResult/recoverInterrupted 中断恢复） | journal 逐节点 + 最长未变前缀零成本回放 | 相当（机制不同） |

## 2. 分项详述（值得追的部分）

### 2.1 Navigator 全屏面板（差距最大，P1 候选）

参考项目 `openWorkflowNavigator`（workflow-ui.ts，~2400 行）是一个完整的 overlay 组件：宿主 overlay 容器内自绘盒式边框，内部状态机有 browse/filter/rename/confirm 四种模式，视图分 runs 列表 / run 详情钻取 / saved 工作流详情，确认动作绑定上下文（cursor + filter + runId 三重校验防误删），支持右侧边栏锚点。

本仓库对应物只有 `/workflows list`（纯文本）与 `/workflows status`（纯文本）。**建议**：不照搬 2400 行，做最小 Navigator（runs 列表 + 详情 + stop/确认），复用 `renderRunStatus` 渲染。

### 2.2 进度 widget 的事件驱动化（机制代差，P0 候选）

| | 参考项目 | 本仓库 |
|---|---|---|
| 数据源 | manager 事件（agentStart/agentEnd/phase/log/tokenUsage + 生命周期事件） | `setInterval` 2s 轮询 `runManager.list()` |
| 刷新策略 | dirty set + 定时节流 + 微任务急行道（lifecycle 事件即时） | 固定间隔全量轮询 |
| 形态 | compact/detailed 两级、maxAgents 截断、设置持久化 | 单行摘要 |
| 空闲成本 | 无事件零刷新 | 空转轮询（2s 一次 list()） |

本仓库 RunManager 目前无事件系统——`attach/finish` 时若补发回调（或简单 EventEmitter），widget 即可改订阅制。这是 P0 级别的机制升级，顺带解决轮询的空闲开销。

### 2.3 watchRun 状态行（P1 候选）

参考项目对单次关注中的 run 用 `ctx.ui.setStatus(key, oneLineProgress)` 挂一行状态，完成时清理状态行并把终态渲染进会话。适合"前台盯着一个 run"的场景；本仓库当前只有全局 widget（多 run 汇总）与手动 `/workflows status`，缺"单 run 专注视图"。

### 2.4 结果回传升级为 customType 消息（P2 候选）

本仓库 `deliver` 用 `pi.sendUserMessage(纯文本)`；参考项目用 `sendMessage({ customType: "workflows", display: true })`，宿主可注册专属渲染器做富展示（进度表/结果结构化）。迁移成本主要在渲染器注册与兼容（sendUserMessage 的"用户消息触发回合"语义可能是有意选择——回传会触发模型看到结果）。

## 3. 设计差异项（不建议照搬，记录取舍）

### 3.1 run 的来源语义
参考项目 `/workflows run <prompt>` 触发 LLM 生成；本仓库 `/workflows run <scriptPath|id>` 确定性执行。这是范式分叉点，保持各自。

### 3.2 pause/resume vs stop+journal 回放
参考项目暂停是快照挂起（PersistedRunState paused 态）；本仓库用 `stop`（journal 保留）+ `resumeFromRunId`（未变前缀零成本回放）覆盖同一需求，且天然容忍脚本变更后的增量重跑。**维持现状**；若用户提出"挂起后改参数再继续"，再评估 pause。

### 3.3 工作流管理形态
参考项目"每个 saved 工作流 = 一个独立斜杠命令"（`/deep-research` 风格），配 saved > builtin 遮蔽；本仓库"集中 manifest + `/workflows run <id>`"。集中制的优势：命令面板不膨胀、manifest 可审计可迁移（register.json 原位路径引用）、register/unregister 显式生命周期。**维持集中制**；若未来某高频工作流需要独立命令，可加"注册时可选 as-command"开关。

### 3.4 注册表存储
参考项目 saved workflow 存 JSON（script 内联，project/user/legacy 三层优先级）；本仓库 manifest 存元数据 + 脚本原位路径引用（不复制，用户明确要求）。两者已按各自用户预期成型，无差距问题。

## 4. 建议补齐优先级汇总

| 优先级 | 项 | 依据 |
|--------|----|------|
| P0 | widget 事件驱动化（RunManager 事件回调替换 2s 轮询） | 机制代差 + 空闲开销 |
| P1 | 最小 Navigator（runs 列表/详情/stop，复用 renderRunStatus） | 体验代差最大项 |
| P1 | watchRun 式单 run 状态行（setStatus） | 小成本高感知 |
| P2 | 回传升级 customType 富渲染 | 锦上添花，需验证 sendUserMessage 语义等价 |
| P2 | `/workflows rm`（带确认；journal 仍可先归档） | 小 |
| 不追 | 关键词武装/effort/ultracode/builtin 命令族 | 不同范式，本仓库定位是确定性编排 |

## 引用说明

- 参考项目源码（只读）：`thirdparties/pi-dynamic-workflows/src/workflow-ui.ts`（Navigator）、`src/workflow-progress.ts`（事件驱动 widget）、`src/display.ts`（快照渲染/widget display）、`src/workflow-commands.ts`（命令 + watchRun）、`src/workflow-editor.ts`（模式武装/进度设置）、`src/run-persistence.ts`（运行持久化）、`src/builtin-commands.ts`（内置工作流命令族）
- 本仓库对应实现：`extensions/pi-code-mode.ts`（widget/deliver）、`extensions/commands/workflows/`（命令族）、`src/engine/runtime/workflow-registry.ts`（manifest 注册表）、`src/engine/persistence/journal.ts`（journal）
- 项目定位与架构约束：`dev-docs/design/pi-code-mode插件需求文档.md`
