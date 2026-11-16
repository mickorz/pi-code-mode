# watchRun 式单 run 专注视图（P1）—— 代码落地（2026-11-16），TUI 手工验收待执行

> 状态：**代码完成，待 TUI 手工验收**　|　参考：`thirdparties/pi-dynamic-workflows/src/workflow-commands.ts` watchRun（只读）
>
> 落地：`extensions/commands/workflows/watch.ts`（watchRun 核心 + watch 子命令，路由表已接入）；
> RunManager 事件驱动（progress 刷新单行、finished/stopped 收尾）；防泄漏三件套（settled + 退订 + 状态行必清理）；
> watchRun 进程内幂等（watching 表 + resetWatchState 测试辅助）；终态详情 renderRunStatus 回传会话；
> 非交互模式（hasUI=false）拒绝并提示替代命令；契约测试 5 例全绿。
>
> 裁剪说明：`/workflows run` 提交后不自动 watch（widget 已有全局汇总，保持显式关注语义）；
> 多 run 并存 watch 依赖宿主 setStatus 多 key 能力，TUI 验收时确认。

## 目标

对单次关注的 run 挂一行 `ctx.ui.setStatus` 实时进度（区别于 widget 的多 run 汇总）：
运行中逐事件刷新单行进度，完成时自动清理状态行并把终态渲染进会话。

## 依赖

- **硬依赖**：「widget 事件驱动化」待办的 RunManager 事件出口（逐事件刷新的前提；无事件出口只能轮询）
- 实施顺序：widget 事件驱动化 → 本任务

## 工作分解

1. **watch 入口**：`/workflows watch <runId>` 子命令（显式关注）；`/workflows run` 提交后台后是否自动 watch 留实施时定（widget 已有全局汇总，自动 watch 是合理默认但可能冗余）
2. **watch 实现**（对照参考项目语义）：
   - 仅对 running 的 run 生效；`key = wf:<runId>` 挂 `ctx.ui.setStatus`
   - 订阅 RunManager 事件：progress 事件刷新单行（`oneLineProgress`：running/done 计数 + label），lifecycle 终态事件收尾
   - 收尾：`setStatus(key, undefined)` 清理 + 终态 `renderWorkflowRunResult` 渲染进会话（复用现有 deliver 通道）
   - 防泄漏：settled 标志 + 监听器注销（参考项目完整实现即模式）；重复 watch 同一 run 幂等；watch 不存在的 id 给提示
3. **多 run 并存**：key 按 runId 隔离，多行状态并存能力以宿主 `ctx.ui.setStatus` 实际行为为准（实施时验证）
4. **测试**（contract，无模型）：watch 状态行内容随事件更新、终态清理、幂等与未知 id 分支（fake ctx.ui.setStatus + 真 RunManager 事件）

## 验收口径

- watch 一个后台 run：状态行即时出现并随节点完成刷新（事件驱动，非轮询）
- run 结束：状态行消失，终态结果自动进会话
- 不 watch 的 run 不产生状态行；会话关闭/重启后无残留泄漏
- `npm run build` + contract/engine 全绿

## 落位

- `/workflows watch` 子命令：`extensions/commands/workflows/watch.ts` + index 路由表一行（遵守 CLAUDE.md 命令开发规范）
- watch 核心逻辑若被 run 子命令复用，抽到独立模块供两处调用
