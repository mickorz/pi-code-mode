# pi-code-mode Workflow Explorer 技术架构设计

> 版本：V1.0
> 日期：2026-11-18
> 状态：**已实现（M0-M6 全部落地，单元/契约测试全绿；交互式 TUI 目视验收待人工执行）**
> 需求来源：[侧边栏sidebar需求文档.md](./侧边栏sidebar需求文档.md)
> 核心调整：单实例常驻不等于 Overlay 组件永久挂载——Controller、运行数据与导航状态常驻，Overlay 视图按需显示隐藏

## 实现落点（代码索引）

| 里程碑 | 落地文件 | 测试 |
| ------ | -------- | ---- |
| M1 Runtime Event Protocol | `src/engine/events/workflow-events.ts`、`src/engine/events/runtime-event-bus.ts`、`src/engine/runtime/workflow-runtime.ts`（埋点）、`src/engine/types/index.ts`（Phase/Tool 记录） | `tests/contract/runtime-events.test.ts` |
| M2 RunManager 扩展 | `src/manager/run-manager.ts`（attachEvent/getSnapshot/lifecycle 事件） | 同上 + `tests/contract/run-manager-events.test.ts` |
| M3 WorkflowTreeModel | `src/explorer/model/workflow-tree-model.ts` | `tests/contract/explorer-tree.test.ts` |
| M4 Controller + Navigation | `src/explorer/controller/explorer-controller.ts`、`src/explorer/model/navigation-model.ts` | `tests/contract/explorer-controller.test.ts` |
| M4 TUI Overlay | `extensions/explorer/index.ts`、`extensions/explorer/render.ts`、`extensions/commands/explorer.ts` | `tests/contract/explorer-render.test.ts`、`explorer-overlay.test.ts`、`explorer-command.test.ts` |
| M5 Journal Detail | `src/engine/persistence/journal.ts`（V2）、`src/explorer/repository/detail-repository.ts` | `tests/contract/journal-v2.test.ts` |
| M6 端到端 | — | `tests/contract/explorer-e2e.test.ts` |

已实施评审修复（2026-11-18 第二轮，问题与修复一一对应）：

| 编号 | 问题 | 修复 | 回归测试 |
| ---- | ---- | ---- | -------- |
| H1 | Explorer 自建 JournalStore，首次读盘后永久命中陈旧缓存（运行中详情不再更新） | 单例 `createRunJournal()` 由写入方与读取方共用（`src/manager/run-journal.ts`） | `explorer-fixes.test.ts` H1 |
| H2 | 切回已存在树的 run 时导航仍绑定旧树（`ensureTree` 早退漏重绑） | 单一 NavigationModel，host 动态解析当前 activeRunId 的树 | H2 |
| H3 | schedule 触发的 run 未接事件/journal，树只剩根节点 | PiScheduleRunner 接 eventBus + journal + onAgentExecution + 摘要落盘 | H3 |
| M1 | child workflow 内 runTool 用裸 phase 标题 → 挂到不存在的 phase（节点不可见）；MCP 硬编码 root | Runtime 新增 `eventPhase()`（与 agent displayPhase 同构）；onMcpCall 携带调用点 scope | M1 |
| M2 | `onAgentExecution` 未接线 → attempts 历史恒空 | workflow 工具与 schedule runner 均接 `journal.recordExecution` | M2 |
| M3 | 详情 End/连续 ↓ 越界成白屏 | `detailMaxScroll` 由渲染层回报，`end()`/`scrollDetail()` 钳制 | M3 |
| M4 | Agents/Tools Tab 复用树可见行（折叠即消失）且无导航 | `listRows`（全树过滤）+ Tab 内 up/down/home/end 移动 + 选中高亮 | M4 |
| L1 | resume 复用 runId 时旧树节点残留 | `run.started` 触发该 runId 的树重建 | L1 |
| L2 | Shift+Tab（CSI Z）未映射，反向切 Tab 不可达 | `mapKey` 增 `[Z` → `shiftTab` | `navigator.test.ts` |

两处与设计文档的实现偏差（已按实现为准）：

1. **展开态用 `collapsedNodeKeys` 而非 `expandedNodeKeys`**：默认全展开（运行中树仅几十节点），仅显式收起时剪枝——用户打开面板即看到完整结构。
2. **隐含阶段节点**：子 workflow 未声明 phase 时，Runtime 用 `"▸ child / "` 前缀作展示阶段且不发 phase 事件；树模型按需建占位阶段节点（同 phaseId 与真实 `phase.started` 合并），避免子流程 agent 丢节点。


---

## 一、架构目标

### 1.1 产品定位

Workflow Explorer 是 pi-code-mode 的统一工作流执行观察界面。

它负责将 Workflow Runtime 的执行过程转换为可视化、可导航、可追踪的执行树。

核心能力：

1. 实时观察多个 Workflow Run。
2. 展示多层嵌套 Workflow 的执行结构。
3. 查看 Phase、Agent、Composite、Tool 的执行状态。
4. 支持上下左右键进行层级导航。
5. 查看 Agent Prompt、Result、错误、Token、耗时。
6. 查看 Journal 历史执行记录及恢复状态。
7. 支持运行期间打开、隐藏、重新打开，不丢失导航状态。
8. 为未来 Web Workflow Dashboard 提供统一的数据接口。

### 1.2 已确认的架构决策

| 决策 | 选择 | 说明 |
| ---- | ---- | ---- |
| Overlay | 单实例常驻 | Controller 和状态常驻，视图按需挂载 |
| Runtime 事件 | 统一事件协议 | Runtime 只负责产生事件，消费端统一订阅 |
| Journal | 复用现有 Journal | 扩展元数据和读取能力，不另建完整事件溯源系统 |
| 架构关系 | Runtime 与 UI 解耦 | Explorer Model 不依赖 Pi TUI |
| 多端支持 | TUI 优先，Web 兼容 | 共用 Runtime Event 和 Explorer Model |
| 运行管理 | 复用 RunManager | 扩展执行快照，不重复建立运行管理器 |

### 1.3 现有可复用基础（已核对当前仓库实现）

- `RunManager` 已经是模块级单例，并支持事件订阅。
- `render-scheduler.ts` 已有生命周期即时刷新、进度 500ms 节流。
- Runtime 已有 Agent、Workflow、Composite 三类执行记录。
- `JournalStore` 已有原子写入、Agent 结果回放和失败 Attempt 历史。
- Navigator 已有完整 Overlay、键盘映射和渲染基础设施。

因此本次不推翻现有架构，主要工作是把目前分散的执行数据统一起来，建立可复用的 Explorer 数据层。

### 1.4 非目标

第一阶段不做：

- 修改 Workflow 的执行调度策略。
- 修改 Agent 的执行机制。
- 实现 Workflow 编辑器。
- 实现可视化 Workflow 编排。
- 实现暂停后继续执行的独立控制机制。
- 新建完整 Event Sourcing 系统。
- 开发独立 Web Dashboard。

---

## 二、整体技术架构

### 2.1 架构图

```
                    pi-code-mode
                         |
                         |
                 Workflow Runtime
                         |
       +-----------------+-----------------+
       |                 |                 |
    Workflow           Agent            Composite
       |                 |                 |
     Phase              Tool              MCP
       |                 |                 |
       +-----------------+-----------------+
                         |
                         v
               Runtime Event Protocol
                         |
                         v
                 Runtime Event Bus
                         |
                         v
                    RunManager
                         |
              +----------+----------+
              |                     |
         Run Snapshot         JournalStore
              |                     |
              |               Execution Detail
              |                     |
              +----------+----------+
                         |
                         v
                Explorer Data Layer
                         |
              +----------+----------+
              |                     |
        WorkflowTreeModel      DetailRepository
              |                     |
        NavigationModel        Journal Reader
              |                     |
              +----------+----------+
                         |
                         v
                  Explorer Controller
                         |
              +----------+----------+
              |                     |
          TUI Adapter           Web Adapter
              |
         Pi Overlay
```

### 2.2 模块职责

| 模块 | 职责 | 是否依赖 Pi TUI |
| ---- | ---- | ------------- |
| Workflow Runtime | 执行 Workflow，产生运行事件 | 否 |
| Runtime Event Protocol | 定义统一事件格式 | 否 |
| Runtime Event Bus | 事件分发 | 否 |
| RunManager | 管理 Run、实时快照、状态查询 | 否 |
| JournalStore | Agent 结果和历史执行持久化 | 否 |
| Explorer Data Layer | 组合执行树和详情数据 | 否 |
| Explorer Controller | 管理单例和导航状态 | 否 |
| TUI Adapter | Overlay、键盘、渲染 | 是 |
| Web Adapter | Web 展示适配 | 否 |

核心原则：

**Runtime 不感知 UI，Explorer Model 不感知 UI，TUI 只是其中一个展示适配器。**

---

## 三、单实例 Explorer 生命周期

这是本次架构的第一个重点。

### 3.1 单实例结构

建议新增：

```
src/explorer/
├── controller/
│   └── explorer-controller.ts
├── model/
│   ├── workflow-tree-model.ts
│   ├── navigation-model.ts
│   └── explorer-state.ts
├── repository/
│   ├── run-repository.ts
│   └── detail-repository.ts
└── types/
    └── explorer-types.ts

extensions/
└── explorer/
    ├── index.ts
    ├── overlay-manager.ts
    ├── explorer-view.ts
    ├── render.ts
    └── keys.ts
```

`ExplorerController` 作为模块级单例：

```
class ExplorerController {
  private visible = false;

  private activeRunId?: string;

  private activeTab:
    | "workflow"
    | "agents"
    | "tools"
    | "journal" = "workflow";

  private treeModel: WorkflowTreeModel;

  private navigationModel: NavigationModel;

  open(): void;

  hide(): void;

  toggle(): void;

  selectRun(runId: string): void;

  selectNode(nodeKey: string): void;

  dispose(): void;
}
```

Controller 生命周期与 Overlay View 生命周期分离。

### 3.2 两层生命周期

**Controller 生命周期**

```
Extension Start
      |
      v
Create ExplorerController
      |
      v
Subscribe RunManager Events
      |
      v
Maintain Explorer State
      |
      +------------------+
      |                  |
      v                  v
    Open               Hidden
      |                  |
      v                  |
  Create View            |
      |                  |
      v                  |
  Render Overlay         |
      |                  |
      +------ Hide ------+
      |
      v
Reopen
      |
      v
Restore Previous State
```

**Overlay View 生命周期**

```
Open
  |
  v
Create Overlay Component
  |
  v
Subscribe View Events
  |
  v
Render
  |
  v
Hide / Close
  |
  v
Dispose View
```

Pi API 的实现约束：

当前 Navigator 使用 `ctx.ui.custom()` 和 `done()` 关闭 Overlay。不能假设 `custom()` 返回一个永久存在、支持任意隐藏和显示的组件句柄。

因此：

- Controller 不销毁。
- Tree Model 不销毁。
- Navigation State 不销毁。
- Overlay View 关闭时释放 UI 资源。
- 再次打开时使用原来的 Controller 和状态。

这实现的是逻辑上的单实例常驻，而不是强制保持 Overlay 组件一直挂载。

### 3.3 打开入口

建议支持三个入口：

| 入口 | 行为 |
| ---- | ---- |
| `/explorer` | 打开或隐藏 Explorer |
| `/explorer <runId>` | 打开并定位到指定 Run |
| 快捷键 | Toggle Explorer |

另外，保留原来的 `/workflows ui` Navigator，不直接替换。

Explorer 是执行观察工作区，Navigator 继续承担 Run 和 Saved 管理职责。

---

## 四、Runtime Event Protocol

这是本次架构最核心的改造。

### 4.1 统一事件结构

新增 `src/engine/events/workflow-events.ts`：

```
export interface WorkflowRuntimeEvent {
  eventId: string;

  runId: string;

  sequence: number;

  timestamp: number;

  type: WorkflowEventType;

  scopePath?: string[];

  nodeKey?: string;

  parentKey?: string;

  payload?: unknown;
}
```

事件类型：

```
export type WorkflowEventType =
  | "run.started"
  | "run.finished"

  | "workflow.started"
  | "workflow.finished"

  | "phase.started"
  | "phase.finished"

  | "agent.started"
  | "agent.updated"
  | "agent.finished"

  | "composite.started"
  | "composite.finished"

  | "tool.started"
  | "tool.finished";
```

事件统一由 Runtime 产生。

### 4.2 Sequence 设计

每个 Run 独立维护递增序号。

例如：

```
run-001

sequence 1  run.started
sequence 2  workflow.started
sequence 3  phase.started
sequence 4  agent.started
sequence 5  agent.updated
sequence 6  agent.finished
sequence 7  workflow.finished
sequence 8  run.finished
```

事件 ID：

```
eventId = `${runId}:${sequence}`;
```

设计要求：

1. Sequence 在事件产生时同步分配。
2. 不依赖 Agent 的完成顺序。
3. 不同 Run 的 Sequence 相互独立。
4. 消费端能够识别重复事件。
5. 旧事件不能覆盖新状态。
6. Sequence 不参与 Journal 的执行寻址。

特别注意：

并发情况下，Agent B 可能比 Agent A 更早完成，但 Agent A 可能更早开始。

Sequence 代表事件发生顺序，不代表节点执行顺序。

### 4.3 Runtime 事件映射

| 当前 Runtime 数据 | 事件 |
| ---------------- | ---- |
| WorkflowExecutionRecord 创建 | workflow.started |
| WorkflowExecutionRecord 完成 | workflow.finished |
| phase() 切换 | phase.started / phase.finished |
| AgentRecord 创建 | agent.started |
| AgentRecord 状态变化 | agent.updated |
| AgentRecord 进入终态 | agent.finished |
| CompositeRecord 创建 | composite.started |
| CompositeRecord 终态 | composite.finished |
| runTool() 调用 | tool.started / tool.finished |
| MCP 调用 | tool.started / tool.finished |
| RunManager.finish() | run.finished |

需要复用已有回调：

- `onAgentUpdate`
- `onCompositeUpdate`
- `onMcpCall`

新增：

- `onWorkflowEvent`
- `onPhaseEvent`
- `onToolEvent`

或者统一改为：

```
onRuntimeEvent?: (
  event: WorkflowRuntimeEvent
) => void;
```

推荐统一入口，避免 Runtime 最终形成多套事件出口。

原有回调可以暂时保留作为兼容层，逐步迁移。

### 4.4 Workflow 生命周期补充

当前 Runtime 已经有 `WorkflowExecutionRecord`。

但目前主要依赖最终结果和对象状态更新，不能直接把它当作完整实时事件流。

建议：

```
const wfRecord = createWorkflowRecord();

emit({
  type: "workflow.started",
  payload: wfRecord,
});

try {
  await executeWorkflow();

  updateWorkflowRecord(wfRecord, "ok");

  emit({
    type: "workflow.finished",
    payload: wfRecord,
  });
} catch (error) {
  updateWorkflowRecord(wfRecord, "failed");

  emit({
    type: "workflow.finished",
    payload: wfRecord,
  });

  throw error;
}
```

注意：

失败、取消、中止都必须保留各自的终态，不能统一映射成失败。

### 4.5 Event Bus

新增 `src/engine/events/runtime-event-bus.ts`：

```
interface RuntimeEventBus {
  publish(event: WorkflowRuntimeEvent): void;

  subscribe(
    listener: (
      event: WorkflowRuntimeEvent
    ) => void
  ): () => void;
}
```

要求：

- 同步分配事件顺序。
- Listener 异常隔离。
- 支持退订。
- 不允许 Listener 阻塞 Runtime。
- 不允许事件消费者反向修改 Runtime 状态。

Runtime Event Bus 只负责进程内分发，不负责持久化。

---

## 五、RunManager 扩展

### 5.1 当前实现

当前 `src/manager/run-manager.ts` 已经支持：

```
type RunEventType =
  | "started"
  | "progress"
  | "finished"
  | "stopped";
```

并且已经具备：

- Run 注册。
- Agent 快照更新。
- 事件订阅。
- Run 状态查询。
- 取消执行。
- 最近 20 个终态 Run 的内存保留。

这部分应当保留。

### 5.2 扩展 ManagedRun

建议增加：

```
interface ManagedRun {
  runId: string;

  label?: string;

  startedAt: number;

  status: RunStatus;

  agents: AgentRecord[];

  workflows: WorkflowExecutionRecord[];

  composites: CompositeRecord[];

  tools: ToolExecutionRecord[];

  phases: PhaseExecutionRecord[];

  lastSequence: number;

  finishedAt?: number;

  error?: string;

  resultPreview?: string;
}
```

其中，工具和 Phase 记录为新增结构。

### 5.3 RunManager 新增接口

```
class RunManager {
  attachEvent(
    event: WorkflowRuntimeEvent
  ): void;

  getSnapshot(
    runId: string
  ): RunSnapshot | null;

  subscribe(
    listener: (
      event: RunManagerEvent
    ) => void
  ): () => void;
}
```

`attachEvent()` 负责：

1. 检查 Sequence。
2. 更新对应节点。
3. 更新 Run 快照。
4. 通知 Explorer。
5. 触发渲染调度。

建议使用以下规则：

```
if (
  event.sequence <= run.lastSequence
) {
  return;
}
```

实际实现时，需要同时处理并发到达和事件缺口，不能简单地因为一个事件晚到就丢弃其他有效节点更新。

### 5.4 快照机制

RunManager 是实时快照的权威来源。

Explorer 不应该每次渲染都重新遍历所有历史事件。

```
Runtime Event
      |
      v
RunManager.attachEvent()
      |
      v
Update Run Snapshot
      |
      v
Notify Subscribers
      |
      v
Explorer Model
```

快照接口：

```
interface RunSnapshot {
  runId: string;

  status: RunStatus;

  lastSequence: number;

  workflows: WorkflowExecutionRecord[];

  agents: AgentRecord[];

  composites: CompositeRecord[];

  tools: ToolExecutionRecord[];

  phases: PhaseExecutionRecord[];
}
```

---

## 六、WorkflowTreeModel

### 6.1 设计目标

新增 `src/explorer/model/workflow-tree-model.ts`。

负责将 Runtime 数据转换为统一的树结构。

不负责渲染，也不负责执行操作。

### 6.2 节点类型

```
type WorkflowTreeNodeKind =
  | "run"
  | "workflow"
  | "phase"
  | "agent"
  | "composite"
  | "tool";
```

### 6.3 节点数据结构

```
interface WorkflowTreeNode {
  nodeKey: string;

  runId: string;

  parentKey?: string;

  kind: WorkflowTreeNodeKind;

  label: string;

  status: string;

  scopePath: string[];

  startedAt?: number;

  endedAt?: number;

  durationMs?: number;

  children: string[];

  metadata?: {
    model?: string;

    tokens?: number;

    attempt?: number;

    replayed?: boolean;
  };
}
```

### 6.4 稳定身份

不能使用数组下标作为节点身份。

推荐：

```
nodeKey = [
  runId,
  kind,
  scopePath.join("/"),
  localNodeId,
].join(":");
```

不同节点的 localNodeId：

| 节点 | 身份来源 |
| ---- | ------ |
| Run | runId |
| Workflow | scopePath |
| Phase | phaseId |
| Agent | AgentRecord.id |
| Composite | scopePath + CompositeRecord.id |
| Tool | scopePath + toolExecutionId |

特别注意：

- Composite 的 cmpN 只在 Scope 内唯一。
- Phase 名称不保证唯一。
- Agent 的 journal key 与展示身份不能混为一谈。
- 同名 Workflow 必须依赖 scopePath 区分。

### 6.5 父子关系

```
Run
 └── Root Workflow
      ├── Phase 1
      │    ├── Agent A
      │    └── Agent B
      │
      ├── Phase 2
      │    ├── Child Workflow
      │    │    ├── Phase 1
      │    │    │    ├── Agent C
      │    │    │    └── Agent D
      │    │
      │    └── Composite
      │         ├── Agent E
      │         └── Agent F
      │
      └── Phase 3
           └── Tool A
```

构建规则：

1. Root Workflow 直接挂在 Run 下。
2. Child Workflow 根据 scopePath 确定父 Workflow。
3. Agent 根据 workflowScopePath 归属 Workflow。
4. Agent 根据 phaseId 归属 Phase。
5. Composite 根据 scopePath 和 compositePath 建立组合关系。
6. Tool 根据调用时的 Workflow Scope 和 Phase 归属。
7. 缺少父节点时先进入待关联集合，不能直接丢弃。

注意：现有 AgentRecord 的 `phase` 是展示名称，不是稳定 Phase ID。需要增加 Phase 身份字段。

### 6.6 并发排序

执行树顺序不应随着完成时间不断变化。

建议节点同时保存：

```
createdSequence: number;
updatedSequence: number;
```

默认排序按照创建顺序，而不是完成顺序。

这样并行 Agent 不会因为执行快慢改变树的位置。

---

## 七、JournalStore 扩展

### 7.1 基本原则

继续复用 `src/engine/persistence/journal.ts`，不新增完整 EventStore。

必须保证：

**Journal 的执行回放语义不能因为 Explorer 的展示需求而发生变化。**

### 7.2 现有数据

当前 Journal 已经支持：

- Agent hash。
- Agent result。
- Model。
- Label。
- Workflow Label。
- Phase。
- Prompt 预览。
- Session ID。
- Output Type。
- Execution ID。
- Attempt。
- Token。
- 执行耗时。
- 历次失败和中止记录。

### 7.3 扩展方向

建议将 Journal 文件结构升级为兼容版本：

```
interface JournalFileV2 {
  version: 2;

  runId: string;

  metadata?: {
    workflowId?: string;

    workflowName?: string;

    label?: string;

    startedAt?: number;

    endedAt?: number;

    status?: string;
  };

  observability?: {
    lastSequence?: number;

    workflows?: WorkflowExecutionRecord[];

    phases?: PhaseExecutionRecord[];

    composites?: CompositeRecord[];

    agents?: AgentRecord[];

    tools?: ToolExecutionRecord[];
  };

  entries: Record<string, JournalEntry>;
}
```

要求：

1. `entries` 原有结构保持兼容。
2. 新字段全部可选。
3. 老版本 Journal 可以读取。
4. 老版本 Journal 不强制迁移。
5. Journal 加载不改变 Agent Hash。
6. Journal 加载不改变 Replay Policy。
7. 展示字段不得参与 Agent 回放判定。

### 7.4 持久化策略

不要将所有 Runtime 事件都写入 Journal。

原因：

- Agent 高频更新会造成大量磁盘写入。
- 并发执行时容易发生写入竞争。
- 当前 Journal 是读合写整个文件。
- Journal 的核心职责是 Agent 结果回放。

建议：

| 数据 | 持久化时机 |
| ---- | -------- |
| Run Metadata | Run 创建、终态 |
| Workflow Record | 创建、终态 |
| Phase Record | 阶段切换、终态 |
| Agent Result | 成功后立即写入 |
| Agent Execution | 每次失败或中止 Attempt |
| Composite Record | 终态或必要快照 |
| Tool Summary | 完成后写入摘要 |

高频进度更新只进入内存快照。

### 7.5 原子写入和并发

必须处理的工程风险：

当前 JournalStore 使用同步读合写整个 JSON 文件。

如果 Runtime Event Bus 和多个执行回调同时触发 Journal 更新，必须避免同一 Run 的写入互相覆盖。

建议：

- 保持单 Run 写入串行化。
- 使用 Run 级写入队列或统一写入入口。
- 保留原子 tmp + rename。
- 不允许 UI 直接写 Journal。
- 对历史读取使用只读接口。

### 7.6 详情读取

新增：

```
class JournalDetailRepository {
  getAgentDetail(
    runId: string,
    agentId: string
  ): Promise<AgentDetail>;

  getAgentExecutions(
    runId: string,
    agentId: string
  ): Promise<AgentExecutionRecord[]>;

  getRunObservability(
    runId: string
  ): Promise<RunObservabilitySnapshot>;
}
```

Prompt 和 Result 采用按需读取。

树模型只保留必要摘要。

特别注意：当前 Prompt 只有 4KB 截断预览。如果需要完整 Prompt，必须明确增加完整内容存储能力，不能把预览字段当作完整数据。

---

## 八、四个 Tab 的数据架构

### 8.1 Workflow Tab

默认视图。

```
Workflow Explorer

Runs   Workflow   Agents   Tools   Journal

▼ 杭州麻将需求分析       RUNNING
  ▼ 需求提取              OK
    ✓ Agent A             12s
    ✓ Agent B             18s

  ▼ 规则分析              RUNNING
    ▼ 结算分析             RUNNING
      ✓ Agent C           21s
      ● Agent D           运行中

  ○ 报告生成              WAITING
```

数据源：`WorkflowTreeModel`。

### 8.2 Agents Tab

```
Agents

Agent A       OK       12s
Agent B       OK       18s
Agent C       OK       21s
Agent D       RUN      运行中
Agent E       WAIT     等待调度
```

展示：

- Agent 名称。
- 所属 Workflow。
- Phase。
- 状态。
- 模型。
- Token。
- Cost。
- 耗时。
- Retry。
- Replay 状态。

### 8.3 Tools Tab

统一展示：

- MCP Tool。
- runTool。
- 其他 Runtime 确定性工具。

```
Tools

✓ filesystem.read
✓ qmd.search
● mcp.codegraph.search
✓ report.generate
```

统一 ToolExecutionRecord：

```
interface ToolExecutionRecord {
  toolId: string;

  name: string;

  kind: "mcp" | "runtime";

  scopePath: string[];

  status: string;

  startedAt: number;

  endedAt?: number;

  durationMs?: number;

  error?: string;
}
```

MCP 参数只保留经过脱敏的摘要，不默认展示完整敏感参数。

### 8.4 Journal Tab

```
Journal

Agent A
  ✓ Attempt 1
  ✓ Result cached

Agent B
  ✗ Attempt 1
  ✓ Attempt 2

Agent C
  ↻ Replayed
```

重点展示：

- Agent 执行历史。
- Retry。
- 成功结果。
- 缓存回放。
- 失败原因。
- 可恢复节点。

---

## 九、Navigation Model

### 9.1 导航状态

```
interface ExplorerNavigationState {
  activeRunId?: string;

  activeTab:
    | "workflow"
    | "agents"
    | "tools"
    | "journal";

  selectedNodeKey?: string;

  expandedNodeKeys: Set<string>;

  currentScopePath: string[];

  focus:
    | "tree"
    | "detail";

  detailScrollTop: number;
}
```

### 9.2 交互规则

| 按键 | Tree | Detail |
| ---- | ---- | ------ |
| ↑ | 上一个节点 | 向上滚动 |
| ↓ | 下一个节点 | 向下滚动 |
| → | 展开/进入 | 下一个节点 |
| ← | 收起/返回父级 | 上一个节点 |
| Enter | 打开详情 | 确认 |
| Esc | 返回上级/隐藏 | 返回 Tree |
| Home | 首个节点 | 详情顶部 |
| End | 末尾节点 | 详情底部 |
| Tab | 切换 Tab | 切换 Tab |

### 9.3 选中状态持久化

同一个 Explorer Controller 内：

- 切换 Tab 不清空 Tree 展开状态。
- 隐藏 Overlay 不清空选中节点。
- 后台节点状态更新不改变选中节点。
- Run 结束不自动切换到其他 Run。
- 选中节点被删除或不可用时，回退到最近的有效父节点。

---

## 十、TUI Overlay 架构

### 10.1 复用现有 Navigator

复用 `extensions/commands/workflows/navigator/`。

可复用：

- Overlay 创建方式。
- Theme 适配。
- 键盘映射基础设施。
- Render Scheduler。
- 自防御渲染策略。

不复用：

- NavigatorModel。
- Runs / Saved 视图状态。
- Navigator 专属业务操作。

### 10.2 新增目录

```
extensions/explorer/
├── index.ts
├── commands.ts
├── overlay-manager.ts
├── explorer-view.ts
├── render.ts
├── keys.ts
└── components/
    ├── header.ts
    ├── run-selector.ts
    ├── workflow-tree.ts
    ├── detail-panel.ts
    ├── status-indicator.ts
    └── tab-bar.ts
```

### 10.3 布局

建议初期使用右侧浮动 Overlay：

```
┌────────────────────────────────────────────┐
│               Main TUI                     │
│                                            │
│  Chat / Agent Output                       │
│                                            │
│                    ┌───────────────────────┤
│                    │ Workflow Explorer    │
│                    │                       │
│                    │ Runs Workflow Agents  │
│                    │                       │
│                    │ ▼ Main Workflow       │
│                    │   ▼ Stage 1           │
│                    │     ✓ Agent A         │
│                    │     ● Agent B         │
│                    │                       │
│                    │ ───────────────────── │
│                    │ Node Detail           │
│                    │                       │
│                    │ Status: Running       │
│                    │ Duration: 15s         │
│                    │ Model: ...            │
│                    └───────────────────────┤
└────────────────────────────────────────────┘
```

布局要求：

- 宽度自适应。
- 支持最大高度。
- 支持终端尺寸变化。
- Tree 和 Detail 独立滚动。
- 节点过多时虚拟化或窗口切片。
- 窄终端自动切换单栏详情模式。

第一阶段先验证实际 Overlay 定位和遮挡效果，不要求真正改变主对话区宽度。

---

## 十一、事件刷新与性能策略

继续复用 `src/manager/render-scheduler.ts`。

### 11.1 两级调度

| 事件类型 | 调度策略 |
| -------- | ------- |
| Run 创建 | 即时 |
| Run 结束 | 即时 |
| Workflow 创建 | 即时 |
| Workflow 结束 | 即时 |
| Agent 开始 | 即时 |
| Agent 结束 | 即时 |
| Agent 高频状态更新 | 500ms 节流 |
| Token 更新 | 500ms 节流 |
| Detail 数据加载 | 异步加载 |

### 11.2 增量更新

不要每次事件到达就重建整棵 Tree。

推荐：

```
treeModel.applyEvent(event);
```

只更新对应节点和父节点状态。

例如：

```
Agent D 完成
    |
    v
Update Agent D
    |
    v
Update Parent Phase
    |
    v
Update Parent Workflow
    |
    v
Request Render
```

### 11.3 性能边界

第一阶段需要测试：

- 1 个 Run。
- 5 个并发 Agent。
- 20 个并发 Agent。
- 100 个执行节点。
- 500 个执行节点。
- 高频状态更新。

不能因为 Tree 渲染异常影响 Runtime 执行。

---

## 十二、测试架构

### 12.1 Runtime Event 测试

- 事件格式校验。
- Sequence 单调递增。
- 并发事件顺序。
- Listener 异常隔离。
- 事件退订。
- 重复事件处理。
- 旧事件不能覆盖新状态。

### 12.2 WorkflowTreeModel 测试

- Root Workflow。
- 多层 Child Workflow。
- 同名 Workflow。
- 重复 Phase 名称。
- Composite 嵌套。
- Agent 并发。
- Tool 归属。
- 父节点延迟到达。
- 中断后的状态重建。

### 12.3 Controller 测试

- 单实例。
- 重复打开。
- 隐藏后重新打开。
- 当前 Run 保持。
- 当前节点保持。
- Tab 状态保持。
- 后台更新不改变焦点。
- 关闭时订阅释放。

### 12.4 Journal 测试

- 老版本 Journal 兼容。
- V2 Journal 读取。
- Agent Result 读取。
- Retry History。
- Replay Policy 不变。
- 并发写入不丢数据。
- 原子写入。
- 损坏文件降级。

### 12.5 端到端测试

构建一个包含以下结构的 Workflow：

```
Main Workflow
│
├── Phase 1
│    ├── Agent A
│    └── Agent B
│
├── Phase 2
│    ├── Child Workflow A
│    │    ├── Agent C
│    │    └── Agent D
│    │
│    └── Child Workflow B
│         └── Agent E
│
└── Phase 3
     └── Agent F
```

验收：

1. 运行中打开 Explorer。
2. 观察 Agent A、B 并发。
3. 进入 Child Workflow A。
4. 后台 Agent E 完成。
5. 当前选中节点不改变。
6. 隐藏 Explorer。
7. 再次打开。
8. 选中状态保持。
9. 中断 Workflow。
10. 使用原有 resume 机制恢复。
11. Explorer 能正确展示回放节点和重新执行节点。

---

## 十三、第一阶段工程实施计划

分成七个里程碑。

### M0：Pi Overlay 与单实例技术验证

交付：

- ExplorerController。
- Overlay Manager。
- 单实例测试。
- 隐藏与重新打开测试。
- 键盘焦点测试。
- 终端缩放测试。

验收：不影响主对话，隐藏重开不丢状态。

### M1：Runtime Event Protocol

交付：

- WorkflowRuntimeEvent。
- RuntimeEventBus。
- Sequence 机制。
- Agent 事件接入。
- Workflow 事件接入。
- Composite 事件接入。
- Phase 事件接入。
- Tool 事件接入。

验收：一棵多层 Workflow 能完整产生统一事件。

### M2：RunManager 扩展

交付：

- ManagedRun 扩展。
- RunSnapshot。
- attachEvent。
- Sequence 检查。
- 事件订阅。
- 生命周期与进度刷新调度。

验收：不依赖 UI 即可通过 RunManager 还原实时执行结构。

### M3：WorkflowTreeModel

交付：

- 稳定 Node Key。
- 父子关系。
- ScopePath 映射。
- 增量更新。
- 并发排序。
- 节点状态传播。

验收：正确构建多层 Workflow 执行树。

### M4：Explorer Controller + TUI

交付：

- 单实例 Controller。
- Workflow Tab。
- Tree 导航。
- Detail Panel。
- 键盘映射。
- 隐藏与重新打开。

验收：可以完整浏览运行中的 Workflow。

### M5：Journal Detail Repository

交付：

- Journal V2 兼容扩展。
- Detail Repository。
- Agent Result 读取。
- Retry History。
- Replay 展示。
- 历史快照恢复。

验收：详情读取不改变原有 Journal 回放语义。

### M6：四 Tab 与完整测试

交付：

- Workflow Tab。
- Agents Tab。
- Tools Tab。
- Journal Tab。
- 并发测试。
- 中断恢复测试。
- 性能测试。
- 完整技术报告。

验收：四个 Tab 能够正确展示同一 Run 的执行情况。

---

## 十四、最终 DoD

### 架构

- Runtime 与 TUI 完全解耦。
- Runtime Event Protocol 统一。
- RunManager 成为实时快照权威来源。
- Explorer Controller 单实例。
- Explorer Model 无 Pi TUI 依赖。
- Journal 复用现有实现。

### 功能

- 多 Run 切换。
- 多层 Workflow 展示。
- Phase 展示。
- Agent 展示。
- Composite 展示。
- Tool 展示。
- Journal 展示。
- 节点详情。
- 键盘 Drill-down。
- 隐藏和恢复状态。

### 稳定性

- 并发事件不丢失。
- 重复事件不导致状态回退。
- UI 异常不影响 Runtime。
- Overlay 关闭正确退订。
- Journal 旧版本兼容。
- Resume 语义不变。
- 终端尺寸变化不崩溃。
- 高频更新不会导致渲染卡顿。

---

## 十五、最终架构结论

本次 Sidebar 不应独立成为一套 UI 功能，而应该成为 pi-code-mode 的统一 Workflow Observability 层。

三个关键决策的最终落点：

**1. 单实例常驻**

通过 ExplorerController 保持状态，而不是强制保持 Overlay 组件挂载。

**2. 统一事件协议**

通过 Runtime Event Bus 将 Workflow、Phase、Agent、Composite、Tool 统一接入 RunManager。

**3. 复用 Journal**

继续让 Journal 负责 Agent 结果回放和执行历史，扩展必要的执行元数据，不将它改造成完整事件溯源系统。

最终形成：

```
Runtime
   |
Runtime Events
   |
RunManager
   |
Explorer Data Model
   |
+----------+----------+
|                     |
Pi TUI              Web
Explorer          Dashboard
```

**最重要的实施原则：先完成 Runtime 事件和执行树，再开发 UI。**

如果先做 UI，最终很容易出现一个能够展示 Agent 列表、但无法正确解释多层 Workflow 执行关系的 Sidebar。

这次应当优先解决数据结构、身份关系和生命周期问题。它们才是未来 TUI 和 Web Dashboard 能否共享的基础。

---

## 十六、实施前边界确认（技术评审意见）

正式实施前需明确三个边界，尤其是第一个。

**1. 不要把 RunManager 变成第二个 JournalStore。**

RunManager 管理内存中的实时状态，JournalStore 管理可恢复的执行结果。两者职责不能混合。历史 Run 的查询应由 Journal Repository 提供，不能依赖最近 20 个 Run 的内存保留机制。

**2. 不要把每个 Runtime Event 都持久化。**

事件协议是实时通信协议，不代表需要完整事件溯源。Agent 结果和关键执行元数据持久化即可。这样能避免影响之前已优化的 Workflow 执行耗时。

**3. Phase 必须有稳定身份。**

目前 `AgentRecord.phase` 是字符串，无法可靠区分同一个 Workflow 中重复出现的同名阶段。建议在新增事件时一并增加 `phaseId`，否则后续树节点去重和恢复会出现隐蔽问题。

**实施顺序结论**：先执行 M0～M3，完成后再进入 M4 UI 开发。M0-M3 决定整个系统的技术基础，适合先做无 UI 的单元测试和集成测试。
