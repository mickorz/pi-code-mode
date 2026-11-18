# Workflow Explorer 执行报告（M0-M6）

> 阶段：Sidebar / Workflow Explorer（执行观察器）
> 完成时间：2026-11-18
> 设计基线：`dev-docs/design/workflow-explorer-架构设计.md`（V1.0）、`dev-docs/design/侧边栏sidebar需求文档.md`
> 状态：代码 + 测试完成；交互式 TUI 目视验收待人工执行

## 1. 交付清单

### 1.1 M1 — Runtime Event Protocol

| 文件 | 内容 |
| ---- | ---- |
| `src/engine/events/workflow-events.ts` | `WorkflowEventType`（13 类）、`WorkflowEventInput`（生产端）、`WorkflowRuntimeEvent`（消费端）、payload 形状表 |
| `src/engine/events/runtime-event-bus.ts` | 进程内总线：publish 时同步分配 sequence/eventId、listener 异常隔离、退订、`lastSequence()`、单例入口 |
| `src/engine/runtime/workflow-runtime.ts` | 统一出口 `onRuntimeEvent`；agent/composite/mcp 事件在既有回调包装点派生（一处包装覆盖全部调用点）；workflow/phase/tool 事件在产生点埋点 |
| `src/engine/types/index.ts` | 新增 `PhaseExecutionRecord`（含稳定 `phaseId`）、`ToolExecutionRecord` |

关键语义：失败/中止保留各自终态（不统一映射 failed）；Sequence 每 run 独立递增、不参与 Journal 寻址；phase 切换自动关闭上一未结束阶段。

### 1.2 M2 — RunManager 扩展

- `ManagedRun` 增加 `workflows/composites/tools/phases/lastSequence`；新增 `RunSnapshot`。
- `attachEvent(event)`：sequence 去重（旧事件不回退状态）→ 按稳定身份 upsert → 发 `lifecycle`（结构性变化，即时渲染）或 `progress`（`agent.updated`，500ms 节流）。
- `getSnapshot(runId)`：Explorer 的唯一实时数据源，渲染不重放历史事件。
- 构造期订阅 bus（同进程恰好一份订阅）；`register/finish` 额外发布 `run.started/run.finished`。

### 1.3 M3 — WorkflowTreeModel

- 稳定 nodeKey：`[runId, kind, scopePath, localId].join("|")`（对照 REF-001 `selectionKey` 教训）。
- 父子：child workflow 按 scopePath 前缀；agent/tool 挂 phase（无 phase 退到 workflow）；composite 按 compositePath 嵌套。
- 父节点晚到：`pendingChildren` 回挂，不丢节点。
- 并发排序：节点带 `createdSequence`，children 按创建序（并行 agent 完成快慢不改变树位置）。

### 1.4 M4 — Controller / Navigation / TUI

- `ExplorerController`（单实例、无 TUI 依赖）：`open(requestRender)/hide()/selectRun/view()/detailFor()/handleKey()`。
  - **生命周期分离**：Controller / TreeModel / 导航状态与 extension 同寿；Overlay 视图关闭只 `dispose` UI，重开恢复选中节点、Tab、展开态。
- `NavigationModel`：双状态分离（导航 vs 展示）、上下左右/enter/esc/home/end/tab、折叠动画（`collapsedNodeKeys`，默认全展开）、选中节点消失时回退。
- `extensions/explorer/render.ts`：宽终端（>=110 列内宽）左树右详情双栏，窄终端单栏降级；行宽用 `truncateToWidth/visibleWidth` 保证不超宽；渲染自防御（异常不外抛）。
- `extensions/explorer/index.ts`：`ctx.ui.custom` + `overlay:true` + `anchor:"right-center"` + `width:"60%"`；键位 q 关闭 / o 切 run / j,k 别名 / tab 切 Tab。
- `extensions/commands/explorer.ts`：`/explorer`、`/explorer <runId>`；非 TUI 模式提示 `/workflows list`、`status` 降级路径。
- 保留 `/workflows ui` Navigator 不动（职责：Run 管理 vs 执行观察）。

### 1.5 M5 — Journal V2 与详情层

- `JournalStore`：V2 兼容扩展（`metadata` / `observability` 全部可选，V1 文件零迁移可读）；新增只读 `getEntry/getRunMetadata/getObservability`；`recordRunSummary` 只补观测字段。
- **回放语义不变**：`entries`（hash/result）逐字节不动，展示字段不参与 Agent hash 与 Replay Policy。
- `JournalDetailRepository`：`getAgentDetail/getAgentExecutions/getRunMetadata/getRunObservability`，按需读、AgentRecord.id 即 journal key。
- run 终态由 tool 层 `persistRunSummary` 一次性写入（不写高频事件，不增热路径磁盘开销）。

### 1.6 M6 — 四 Tab + 测试

Workflow / Agents / Tools / Journal 四 Tab 数据源统一由 `ExplorerController.view()` 提供。

新增测试（7 个文件，37 用例）：

| 文件 | 覆盖 |
| ---- | ---- |
| `tests/contract/runtime-events.test.ts` | bus 语义、13 类事件埋点、终态区分 |
| `tests/contract/explorer-tree.test.ts` | 多层树、同名 workflow、重复 phase、并发排序、父节点晚到、旧事件丢弃、composite |
| `tests/contract/explorer-controller.test.ts` | 关闭重开保持、后台更新不抢焦点、Tab 切换、切 run、导航语义、dispose 不泄漏 |
| `tests/contract/explorer-render.test.ts` | 空态、宽/窄布局、四 Tab、折叠、详情、中文换行 |
| `tests/contract/explorer-overlay.test.ts` | 右侧栏参数、q/esc 语义、j/k 别名、o 轮换、dispose 后恢复 |
| `tests/contract/explorer-command.test.ts` | 命令注册、非 TUI 降级、未知 runId 不打开面板 |
| `tests/contract/journal-v2.test.ts` | V1 兼容、V2 写入不动 entries、详情读取、损坏降级、无 tmp 残留 |
| `tests/contract/explorer-e2e.test.ts` | 设计 §12.5 验收场景全流程 |

## 2. 验证结果

| 项 | 结果 |
| -- | ---- |
| `npm run build`（tsc 类型检查） | 通过 |
| `npm run test:engine` | 206/206 通过 |
| `npm run test:contract` | 124/124 通过（含新增 37 用例） |
| extensions 类型检查（临时 tsconfig 含 extensions） | 新增文件 0 错误（既有 navigator/widget 的既有告警不在本次范围） |
| 真实宿主加载 `BILI_PI_INLINE=1 pi -ne -e . -p "只回复 ok"` | 通过（扩展装配无异常，输出 ok） |
| 交互式 TUI（`/explorer` 打开、定位、缩放） | **待人工执行**（本环境无法驱动真实 TUI） |

## 3. 与设计文档的偏差

1. **展开态改为 `collapsedNodeKeys`（默认全展开）**：运行中的树通常只有几十个节点，默认展开信息量更大；`left()` 显式收起。原设计写的是 `expandedNodeKeys`。
2. **隐含阶段节点**：子 workflow 未声明 phase 时 Runtime 的 `AgentRecord.phase` 是 `"▸ child / "` 前缀串且不发 phase 事件；树模型按需建占位阶段节点（与真实 `phase.started` 同 phaseId，后到即合并），否则子流程 agent 会因父节点缺失而不可见。
3. **Overlay 宽度固定 60%**：`overlayOptions` 与 `ui.custom` 的 factory 参数不在同一作用域，取不到 `tui.terminal.columns`；窄终端由渲染层内部降级为单栏（不追求真分栏）。

## 4. 遗留问题

1. **交互式目视验收未执行**：需人工跑 `pi -ne -e .` → `/explorer`，核对右侧栏遮挡、焦点切换、终端缩放、窄终端降级。
2. **第二阶段真分栏未做**（按设计本就分阶段）：需 Pi TUI 提供 Dock/Panel 扩展点，或参考 REF-007 compositor 路线。
3. **MCP 工具节点只发 finished**：`McpToolCallSummary` 在调用结束才产生，Tools Tab 无 running 态（不影响结构正确性）。
4. **Prompt 仍是 4KB 截断预览**：详情面板展示的是 journal 里的预览字段，完整 prompt 未存储（设计 §7.6 已标注该边界）。
5. **历史 run 树依赖内存**：`RECENT_KEEP=20` 之外的 run 只能靠 Journal V2 `observability` 回看（当前 UI 尚未读该快照，仅提供 Repository 接口）。
