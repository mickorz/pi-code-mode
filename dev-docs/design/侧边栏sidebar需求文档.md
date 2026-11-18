# Sidebar（右侧工作栏）需求文档

> 状态：需求已确认，待产出第一阶段技术方案与执行计划
> 整理说明：本文档由多轮设计讨论记录整理而成，去除对话痕迹与失效链接，保留确认过的需求、设计与决策
> 复刻对象：REF-001 `thirdparties/opencode-dynamic-workflows`（UI 完全参考其实现，源码已在固定 commit `7f6e93a` 核对）

## 1. 背景与目标

pi-code-mode 是 pi agent 的 Workflow 编排插件（Workflow Runtime），已有：

- `extensions/pi-code-mode.ts`：插件入口（只做装配）
- Workflow Runtime：执行、并发、Journal、取消与恢复
- AgentAdapter / PiAgentAdapter：子 Agent 会话管理
- MCP Policy：MCP Server 和 Tool 的授权与暴露控制
- `/workflows ui` Navigator：Run 管理入口（Runs/Saved 视图、Run 详情下钻、停止/注销）

目标：为 pi-code-mode 增加右侧栏，作为上述能力的统一可视化入口，让用户看见整个 Workflow 执行过程发生了什么。UI 完全参考 `thirdparties/opencode-dynamic-workflows` 的右侧栏实现：右边栏展示执行树，点击/进入后可查看子 Workflow 的详细执行内容。

核心要解决的三个问题：

1. 看见整个 Workflow 的执行结构。
2. 点击某个子 Workflow，进入它自己的执行详情。
3. 在子 Workflow 之间通过键盘上下左右切换，不影响正在运行的任务。

## 2. 结论与已定决策

| 决策项 | 结论 |
|--------|------|
| UI 复刻对象 | `thirdparties/opencode-dynamic-workflows`（REF-001），不再自研从零渲染 |
| 产品定位 | 独立 TUI 子系统，命名 Workflow Explorer |
| 最终形态 | 左侧主对话 + 右侧工作区（Workflow / Agents / Tools / Journal 四 Tab），Workflow 内支持 Run → 子 Workflow → Phase → Agent/Tool → Detail 递归浏览 |
| 首阶段形态 | Overlay 浮动式（不修改 Pi 源码、不 fork Pi TUI） |
| 架构红线 | UI 与 Runtime 完全解耦，Runtime 为唯一事实源 |
| 现有 Navigator | 保留不动，不删除、不合并进 Sidebar |

## 3. 产品形态

### 3.1 整体布局

```
pi-code-mode TUI
+--------------------------+---------------------------+
| 左侧：主对话              | 右侧：工作流工作区          |
|                          |                           |
| Agent Chat               | Workflow   执行树与子流程导航 |
|                          | Agents     Agent 状态与详情  |
|                          | Tools      MCP 和工具调用     |
|                          | Journal    执行记录与恢复点    |
+--------------------------+---------------------------+
```

### 3.2 四个 Tab

| Tab | 展示内容 |
|-----|---------|
| Workflow | 当前 Workflow、Stage、执行进度、依赖关系（最重要） |
| Agents | 子 Agent 列表、状态、当前任务、模型（最重要） |
| Tools | MCP 工具、调用记录、执行结果 |
| Journal | 执行历史、错误、恢复点、耗时 |

Workflow Tab 内部：可展开的 Workflow 树 + 选中节点详情。树形结构示意：

```
pi-code-mode · Workflow                    RUNNING

需求分析 Workflow                           3/4 Agents

  ▼ 需求提取        提取原始需求
  ▶ 规则分析 Agent   规则子 Workflow
      ├ 结算公式分析
      └ 生成检查报告

节点详情 2/3 —— 结算公式分析                Running · Agent · 12.4s
正在分析结算规则与服务端实现的对应关系……

← 上一个节点        下一个节点 →
```

### 3.3 与现有 `/workflows ui` Navigator 的职责边界

| 入口 | 职责 |
|------|------|
| `/workflows ui` Navigator（已有） | Run 管理入口：启停、注销、Saved 管理 |
| Workflow Sidebar（新增） | 执行过程观察入口：树形浏览、下钻详情 |

两者职责不同，可共用底层 Model 和数据适配器，但不合并成一个组件。

## 4. 核心交互：Workflow Drill-down（逐层下钻）

### 4.1 键盘交互

| 按键 | 功能 |
|------|------|
| ↑ / ↓ | 在当前 Workflow 树中切换节点 |
| → / Enter | 展开子 Workflow 或进入节点详情 |
| ← / Esc | 返回上一级 |
| ← / →（详情态） | 在节点详情中切换上一个、下一个节点 |
| Home / End | 跳到第一个、最后一个节点 |

当前节点有子 Workflow 时，支持从节点进入子 Workflow，再通过左键返回父级，递归下钻不限层数。

### 4.2 双状态模型：导航状态与展示状态分离

- **导航状态**：当前选中树的哪个节点。
- **展示状态**：详情区正在展示哪个节点的内容。

两个状态不能混为一个，否则实时更新与跨节点切换会出现错位。节点状态更新不得重置用户当前选中位置。

### 4.3 复刻对象的关键实现（已在 REF-001 固定 commit 核对）

| REF-001 文件 | 职责 |
|--------------|------|
| `src/tui/workflow-store.ts` | 构建多层 Workflow 树、选择节点、上下移动 |
| `src/tui/plugin.tsx` | 右侧栏、全屏路由、键盘焦点管理 |
| `src/tui/result-view.ts` | 节点执行结果的状态解析 |

两个必须保留的设计：

1. **`selectionKey(runId, nodeId)`**：用 Run ID + Node ID 组成稳定选中标识，避免多个并行 Workflow 中节点 ID 相同导致导航错乱（`workflow-store.ts:448`）。
2. **`buildNestedRunRows()`**：根据父子 Session 关系，把子 Run 插入到触发它的 Agent 节点下面，而不是把所有子 Workflow 追加到列表末尾（`workflow-store.ts:405`）。

复刻方式：复用其交互模型，结合 Pi 的 TUI 能力重做渲染层，不直接复制其 TUI 代码。

## 5. 技术设计

### 5.1 分层架构

```
Workflow Sidebar        运行中的 Run / Workflow 树 / 节点导航
        |
Tree Model              父子关系、节点顺序、选中状态、上下级导航
        |
Detail Model            Prompt、执行状态、结果、错误、耗时、Token
        |
Runtime Event Adapter   RunManager / WorkflowExecutionRecord / AgentRecord / Journal
        |
Workflow Runtime / AgentAdapter / Journal   （唯一事实源，不依赖任何 TUI）
```

```
Workflow Runtime
    |  workflow started / agent started / agent completed
    |  child workflow started / tool called / workflow completed
    v
RunManager Events
    v
WorkflowTreeModel
    +---------+----------+
    v                    v
 Sidebar             Detail View
```

### 5.2 节点数据模型

```ts
interface WorkflowTreeNode {
  id: string;
  runId: string;
  parentId?: string;

  kind: "workflow" | "phase" | "agent" | "tool" | "composite";

  label: string;
  status: "pending" | "running" | "completed" | "failed";

  children: WorkflowTreeNode[];

  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;

  sessionId?: string;
  journalKey?: string;
}
```

约束：

- `runId + id` 作为稳定节点身份（对应 selectionKey 设计）。
- 子 Workflow 必须保留父子关系（对应 buildNestedRunRows 设计）。
- Agent、Tool、Composite 都是可观察节点。
- 结果数据（完整 Prompt、执行结果）从 Journal 按需获取，不塞进 Sidebar 状态。
- 节点状态更新不能重置用户当前选中位置。

### 5.3 键盘导航双模式

**Tree 模式**

- 上下：选择节点；右：展开子节点；左：收起子节点；Enter：进入详情。

**Detail 模式**

- 左右：切换同一执行树中的前后节点；上下：浏览详情内容；Esc：返回 Tree 模式。

### 5.4 事实源原则（设计原则）

1. TUI Adapter 只负责展示，不参与 Workflow 调度。
2. Workflow Runtime 不依赖 `@mariozechner/pi-tui`。
3. 右侧栏订阅 Runtime 事件，不定时轮询。
4. 暂停、恢复、取消等操作通过现有 Runtime API 执行。
5. TUI 关闭或隐藏，不影响后台 Workflow 执行。
6. RPC、JSON、Print 模式不依赖右侧栏。

UI 只是订阅者。关闭 Sidebar 不停止 Agent，不改变执行顺序。未来 Web Dashboard 复用同一套状态和事件协议。

## 6. Pi TUI 能力边界与实现路线

### 6.1 Pi TUI 扩展能力盘点

| API | 用途 | 是否适合右侧栏 |
|-----|------|--------------|
| `ctx.ui.setWidget()` | 编辑器上下方的持久 Widget | 不适合 |
| `ctx.ui.setStatus()` | 状态栏信息 | 不适合 |
| `ctx.ui.setFooter()` | 自定义底部区域 | 不适合 |
| `ctx.ui.custom()` | 自定义交互组件 | 适合 |
| `ctx.ui.custom({ overlay: true })` | 浮层组件 | 可以模拟 |

关键结论：Pi 有自定义 TUI 组件和右侧定位浮层能力，但**没有原生的固定 Dock Sidebar 扩展接口**。Overlay 方式实现的是悬浮在右侧的工作面板，不是把主界面真正分割成左右两栏；窄终端下需要隐藏或调整宽度。

Overlay 示例（官方文档将 Overlay 标注为 Experimental，实现前必须针对当前安装的 Pi 版本验证 API）：

```ts
const handle = ctx.ui.custom(
  (tui, theme, keybindings, done) => {
    return new WorkflowSidebar({ tui, theme, keybindings });
  },
  {
    overlay: true,
    overlayOptions: { anchor: "right-center", width: 42 },
  },
);
```

### 6.2 两阶段实现路线

**第一阶段：Overlay 右侧栏**

- 使用 `ctx.ui.custom()` + `overlay: true` + `anchor: "right-center"`。
- 快捷键控制显示和隐藏。
- 支持 Workflow / Agents / Tools / Journal 四个 Tab。
- 接入现有 Runtime 事件。
- 终端宽度不足时自动隐藏。
- 不需要修改 Pi 源码。

**第二阶段：真正的固定右侧栏（仅在验证 Overlay 无法满足后评估）**

- 左侧聊天区域 + 右侧固定面板，主聊天区域自动缩窄。
- 两栏之间支持拖动调整宽度。
- 右侧栏始终保留，不覆盖聊天内容。

第二阶段需要 Pi TUI 本身提供 Dock/Panel 布局扩展点，普通 Extension Overlay 无法完整实现，或需要维护一份 Pi TUI 定制实现。第一阶段在架构上为第二阶段留接口（Tree Model / Detail Model / Event Adapter 与渲染层分离）。

## 7. 参考项目

### 7.1 已入库参考（thirdparties/）

| 项目 | REF | 实现方式 | 研究重点 |
|------|-----|---------|---------|
| opencode-dynamic-workflows | REF-001 | opencode 右侧栏 + Drill-down | **UI 复刻对象**：执行树、selectionKey、buildNestedRunRows、全屏路由、焦点管理 |
| pi-sidebar-tui | REF-007 | Terminal Compositor（缩窄主终端渲染宽度，右侧独立绘制） | 真分栏的模拟实现思路（无 LICENSE，禁止复制代码） |
| pi-sidebar | REF-010 | Pi Overlay | 原生 Overlay 右侧栏的实现与局限 |
| pi-ui-extension | REF-008 | Fullscreen TUI | 全屏布局、可拖动分栏、面板组织 |
| pi（官方） | REF-005 | - | `packages/coding-agent/examples/extensions/overlay-qa-tests.ts`：9 个锚点定位、Overlay 尺寸边距、响应式隐藏、焦点管理、Overlay 堆叠 |

### 7.2 技术路线对比

| 路线 | 实现方式 | 真正分栏 | 备注 |
|------|---------|---------|------|
| Pi Overlay | 官方扩展 API | 否 | 第一阶段路线 |
| Terminal Compositor | 修改终端渲染宽度 | 是（模拟） | pi-sidebar-tui 路线 |
| Fullscreen TUI | 独立全屏布局 | 是 | pi-ui-extension 路线 |
| Side Panel Host | 多扩展共享面板 | 是 | pi-panels 路线（见 7.3） |

### 7.3 备选路线：pi-panels 共享面板（未入库，待评估）

讨论中曾评估基于 `@luan.sh/pi-panels` 的集成方案：pi-code-mode 向公共 Sidebar 注册自己的 Workflow Tab，而非独占整个右侧栏。其 Provider API 形态：

```ts
import { registerSidePanelProvider } from "@luan.sh/pi-libtui";

registerSidePanelProvider({
  id: "pi-code-mode",
  session: context.sessionManager,
  attach(panel) {
    panel.addTab({
      id: "workflow",
      label: "Workflow",
      create: (host, theme) => new WorkflowPanel(host, theme),
    });
    return () => { /* cleanup */ };
  },
}, globalThis);
```

若采用该路线的三个实施要求：不强制依赖 pi-panels（无宿主时降级 Overlay）；Runtime 事件与 UI 解耦；不复制 pi-panels 布局代码，先验证 Provider API。

当前决策：**优先复刻 REF-001 方案**，pi-panels 仅作为后续备选保留记录。若评估，需验证当前 Pi 版本兼容性、`pi-libtui` 依赖加载方式和多 Extension 共存情况。

## 8. 任务拆分（T0-T6）

| 阶段 | 任务 | 交付 |
|------|------|------|
| T0 | 盘点 REF-001 与本项目现有导航实现 | 能力映射表 |
| T1 | WorkflowTreeModel | 多层树、父子关系、稳定选中（selectionKey） |
| T2 | Sidebar 集成 | 右侧树形展示 |
| T3 | Drill-down 导航 | 上下左右、进入和返回 |
| T4 | Node Detail | Prompt、Result、Journal、错误 |
| T5 | 实时更新 | 并发执行、节点状态同步 |
| T6 | 恢复与边界测试 | 中断、恢复、节点新增、节点消失 |

## 9. 待验证事项与风险

1. **Overlay API 为 Experimental**：实现前必须针对当前安装的 Pi 版本验证 `ctx.ui.custom` overlay 参数、锚点定位与焦点管理行为（可参考 REF-005 的 overlay-qa-tests 示例）。
2. **窄终端降级**：Overlay 非真分栏，需定义宽度阈值与自动隐藏行为。
3. **实时更新不丢选中**：并发执行下节点状态高频变化，需验证选中位置与展示状态不被重置。
4. **恢复场景**：Workflow 中断恢复后（journal 重放），树模型需正确重建且保持父子关系。
5. **焦点冲突**：Sidebar 与主对话输入框、现有 `/workflows ui` Navigator 的键盘焦点管理需要明确切换规则。
