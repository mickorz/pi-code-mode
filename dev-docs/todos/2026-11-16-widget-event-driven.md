# 进度 widget 事件驱动化（P0）

> 状态：待启动　|　依据：TUI 能力对比文档 §2.2（机制代差：轮询 vs 事件）、2026-11-16 决策确认
> 参考：`thirdparties/pi-dynamic-workflows/src/workflow-progress.ts`（事件驱动发布管线，只读）

## 目标

`workflow-tasks` widget 从 2s `setInterval` 轮询 `runManager.list()` 改为事件订阅：
run 生命周期与节点进度事件驱动刷新，空闲零开销，状态变化即时可见。

## 现状问题

- `extensions/pi-code-mode.ts` → `installTaskWidget`：每 2s 全量 `runManager.list()` + 逐 running 调 `status()`，
  空转轮询（无在途 run 也照转），状态变化最多延迟 2s 才可见
- RunManager（`src/manager/run-manager.ts`）无事件出口，widget 只能靠轮询

## 工作分解

1. **RunManager 补事件出口**（最小回调集，不引入完整 EventEmitter）：
   - `onEvent(listener)` / 移除接口；事件 `{ runId, type, ... }`
   - 触发点：`register`（started）、`attach`（progress，节点状态更新）、`finish`（completed/failed/cancelled）、`cancel`（stopped）
2. **widget 改订阅制**（对照参考项目两级发布管线）：
   - 急行道：lifecycle 类事件（started/finished/stopped）→ 微任务即时刷新（出现/消失不延迟）
   - 节流道：progress 类事件（attach 节点更新）→ dirty set + 定时器批量刷新（如 500ms，参考项目 PROGRESS_INTERVAL_MS 同思路）
   - 删除 setInterval；render 保留现有自防御（try/catch 返回空行集——2026-11-15 击穿宿主的教训注释必须保留）
3. **测试**（contract，无模型）：
   - RunManager 事件触发时序：register/attach/finish/cancel 各自产生正确事件
   - 节流语义：连续 attach 合并为一次刷新；lifecycle 事件不被节流吞掉
   - widget render 对异常快照的自防御不回退
4. **可选后续**（不阻塞本任务，对照参考项目 loadProgressMode/loadProgressMaxAgents）：
   compact/detailed 双面板模式、maxAgents 截断、设置持久化——待实际使用反馈再定

## 验收口径

- 发起后台 run：widget **立即**出现（register 事件，非最多 2s 延迟）
- 节点完成逐个刷新（attach 节流批量），结束即时消失（finish 事件）
- 无在途 run 时零轮询（无定时器空转）
- `npm run build` + contract/engine 全绿；宿主 `pi -p`（hasUI=false 跳过 widget 注册）不受影响

## 依赖与顺序

- 无前置依赖；RunManager 事件出口与「Navigator 完整复刻」待办共享（navigator 实时刷新直接复用），建议先行实施
- 改动落位：`src/manager/run-manager.ts`（事件出口）+ `extensions/pi-code-mode.ts`（widget 订阅）；按 CLAUDE.md 命令开发规范不新增命令文件
