/**
 * ExplorerController —— Workflow Explorer 单实例控制器（M4）。
 *
 * 生命周期设计（架构设计 §3，本次架构的关键调整）：
 *   单实例常驻 ≠ Overlay 组件常驻。Controller / TreeModel / NavigationState 在 extension 装配期创建，
 *   与 pi 会话同寿；Overlay View 只在打开时创建、关闭时 dispose（ctx.ui.custom 的 done() 生命周期）。
 *   因此"关闭再打开"只重建 UI，不丢选中节点、展开态与 Tab。
 *
 * 无 TUI 依赖：本文件只依赖 RunManager + 数据模型，TUI 是 extensions/explorer/ 下的一个适配器。
 * Runtime 事件必须不能反向影响执行——Controller 只订阅、只读。
 */

import type { RunManager, RunSnapshot } from "../../manager/run-manager.js"
import type { WorkflowRuntimeEvent } from "../../engine/events/workflow-events.js"
import type { RuntimeEventBus } from "../../engine/events/runtime-event-bus.js"
import { JournalStore } from "../../engine/persistence/journal.js"
import { JournalDetailRepository, type AgentDetail } from "../repository/detail-repository.js"
import { WorkflowTreeModel, type WorkflowTreeNode } from "../model/workflow-tree-model.js"
import { NavigationModel, type ExplorerTab, type NavigationEffect } from "../model/navigation-model.js"
import path from "node:path"

export interface ExplorerRunRow {
  runId: string
  label?: string
  status: string
  startedAt: number
  finishedAt?: number
  /** 节点统计（workflow 数 / agent 完成进度） */
  workflows: number
  agentsTotal: number
  agentsDone: number
}

export interface ExplorerViewState {
  runs: ExplorerRunRow[]
  activeRunId?: string
  activeTab: ExplorerTab
  /** 当前可见行（树展开序，受折叠影响） */
  rows: WorkflowTreeNode[]
  /**
   * 当前 Tab 的列表行：
   *   - workflow Tab = 树可见行（同 rows）
   *   - agents/tools/journal Tab = 全树对应类型节点（评审修复 M4：不受树折叠影响）
   */
  listRows: WorkflowTreeNode[]
  /** 选中节点在 listRows 中的下标（Tab 列表高亮用） */
  listSelectedIndex: number
  /** 显式收起的节点（渲染展开/折叠标记用） */
  collapsedNodeKeys: Set<string>
  selectedIndex: number
  focus: "tree" | "detail"
  detailScrollTop: number
  selected?: WorkflowTreeNode
  detail?: NodeDetailView
}

export interface NodeDetailView {
  node: WorkflowTreeNode
  /** Agent 节点：journal 详情（可能尚未落盘，undefined = 无可用数据） */
  agent?: AgentDetail
  /** 从树模型拿到的祖先链（近 → 远），详情头部"路径"用 */
  ancestors: WorkflowTreeNode[]
}

export interface ExplorerControllerDeps {
  runManager: RunManager
  /** 事件总线：Controller 自己订阅（不依赖 RunManager 的 run 事件，避免与 widget 抢节流语义） */
  eventBus?: RuntimeEventBus
  cwd?: string
  /** journal 目录（journal 未注入时按它新建；与 run-journal 的 RUN_JOURNAL_DIR 一致） */
  journalDir?: string
  /**
   * 评审修复 H1：必须传入与写入方同一个 JournalStore 实例。
   * JournalStore 的 entries 缓存由写入方原地更新，共用实例才能让详情实时可见；
   * 自建实例会首次读盘后永久命中陈旧副本。缺省自建（仅测试/独立只读场景）。
   */
  journal?: JournalStore
}

const DEFAULT_JOURNAL_DIR = path.join(".pi", "workflows", "journal")

export class ExplorerController {
  readonly runManager: RunManager
  private readonly eventBus?: RuntimeEventBus
  private readonly cwd: string
  private readonly journalDir: string
  private readonly journalOverride?: JournalStore

  private visible = false
  private activeRunId?: string
  private readonly trees = new Map<string, WorkflowTreeModel>()
  /**
   * 单一导航模型，host 动态解析**当前** activeRunId 的树。
   * 评审修复 H2：不要按 run 重建/重绑 nav —— 树已存在时 ensureTree 早退会漏重绑，
   * 导致切回旧 run 后导航仍指向另一个 run 的树。
   */
  private readonly navigation: NavigationModel
  private journalFor?: { runId: string; repo: JournalDetailRepository }

  /** UI 适配器注册的重绘回调（Overlay 打开时设置，关闭时清空） */
  private requestRender?: () => void
  private readonly unsubscribe?: () => void

  constructor(deps: ExplorerControllerDeps) {
    this.runManager = deps.runManager
    this.eventBus = deps.eventBus
    this.cwd = deps.cwd ?? process.cwd()
    this.journalDir = deps.journalDir ?? path.join(this.cwd, DEFAULT_JOURNAL_DIR)
    this.journalOverride = deps.journal
    this.unsubscribe = this.eventBus?.subscribe((event) => this.onRuntimeEvent(event))
    this.navigation = new NavigationModel({
      rootKey: () => this.tree?.rootKey ?? "",
      node: (key) => this.tree?.getNode(key),
    })
  }

  /** Overlay 打开时由 TUI 适配器调用；返回的 release 在 Overlay 关闭时调用（不销毁状态） */
  open(requestRender: () => void): void {
    this.visible = true
    this.requestRender = requestRender
    // 默认定位：优先在途 run，其次最近一次
    if (!this.activeRunId || !this.runManager.getSnapshot(this.activeRunId)) {
      this.activeRunId = this.pickDefaultRun()
    }
    if (this.activeRunId) this.ensureTree(this.activeRunId)
    this.navigation?.ensureSelection()
    this.requestRender()
  }

  hide(): void {
    this.visible = false
    this.requestRender = undefined
  }

  get isVisible(): boolean {
    return this.visible
  }

  get activeRun(): string | undefined {
    return this.activeRunId
  }

  get nav(): NavigationModel {
    return this.navigation
  }

  /** 切到指定 run（/explorer <runId> 与 Runs 选择共用）；保留原 run 的树与展开态 */
  selectRun(runId: string): boolean {
    if (!this.runManager.getSnapshot(runId)) return false
    this.activeRunId = runId
    this.ensureTree(runId)
    this.navigation?.ensureSelection()
    this.requestRender?.()
    return true
  }

  /**
   * 渲染层回报详情内容的最大滚动起点（评审修复 M3）。
   * 内容行数只有渲染层在拿到宽度后才知道，导航状态必须由它回填，否则 End 会越界成白屏。
   */
  noteDetailMaxScroll(maxStart: number): void {
    this.navigation.setDetailMaxScroll(maxStart)
  }

  /** 当前 run 的树模型（TUI 渲染与测试用） */
  get tree(): WorkflowTreeModel | undefined {
    return this.activeRunId ? this.trees.get(this.activeRunId) : undefined
  }

  /** 详情：Agent 节点按需读 journal；其他节点直接取节点元数据 */
  detailFor(nodeKey: string): NodeDetailView | undefined {
    const tree = this.tree
    if (!tree) return undefined
    const node = tree.getNode(nodeKey)
    if (!node) return undefined
    const ancestors = tree.ancestorsOf(nodeKey)
    const agent = node.kind === "agent" ? this.repo().getAgentDetail(localAgentId(nodeKey)) : undefined
    return { node, agent, ancestors }
  }

  /** 当前视图快照（TUI 渲染的唯一入口） */
  view(): ExplorerViewState {
    const nav = this.navigation
    nav.pruneSelection()
    const rows = nav.visibleRows()
    const activeTab = nav.state.activeTab
    // tabRows 可能把选中项迁到本 Tab 的第一个同类节点，因此 selected 必须在它之后取
    const listRows = activeTab === "workflow" ? rows : this.tabRows(activeTab, nav.selectedNode?.nodeKey)
    const selected = nav.selectedNode
    return {
      runs: this.runRows(),
      activeRunId: this.activeRunId,
      activeTab,
      rows,
      listRows,
      listSelectedIndex: listRows.findIndex((r) => r.nodeKey === selected?.nodeKey),
      collapsedNodeKeys: nav.state.collapsedNodeKeys,
      selectedIndex: nav.selectedIndex(rows),
      focus: nav.state.focus,
      detailScrollTop: nav.state.detailScrollTop,
      selected,
      detail: selected ? this.detailFor(selected.nodeKey) : undefined,
    }
  }

  /**
   * 非 workflow Tab 的列表：全树同类型节点（不经折叠过滤）。
   * 选中节点若不在该类型列表里，用第一个同类型节点兜底定位（保证 Tab 内有可见高亮）。
   */
  private tabRows(tab: ExplorerTab, selectedKey?: string): WorkflowTreeNode[] {
    const tree = this.tree
    if (!tree) return []
    const kind = tab === "agents" ? "agent" : tab === "tools" ? "tool" : "agent"
    const all = tree.flatten().filter((n) => n.kind === kind)
    if (!all.length) return all
    if (selectedKey && all.some((n) => n.nodeKey === selectedKey)) return all
    // 选中项不在本 Tab 类型内：把选中点迁到第一个同类节点，避免"高亮在别的 Tab 的行上"
    this.navigation.state.selectedNodeKey = all[0].nodeKey
    return all
  }

  /**
   * 逻辑键分发（TUI 适配器把原始字节归一化后调用）。
   * 评审修复 M4：非 workflow Tab 里上下/Home/End 移动的是该 Tab 的列表行，
   * 而不是（可能不可见的）树行，否则按 j/k 没有任何可见反馈。
   */
  handleKey(key: string): NavigationEffect[] {
    const nav = this.navigation
    if (nav.state.activeTab !== "workflow" && nav.state.focus === "tree") {
      const list = this.tabRows(nav.state.activeTab, nav.selectedNode?.nodeKey)
      if (list.length) {
        const cur = list.findIndex((r) => r.nodeKey === nav.selectedNode?.nodeKey)
        if (key === "up" || key === "down") {
          const next = Math.min(list.length - 1, Math.max(0, cur + (key === "up" ? -1 : 1)))
          nav.select(list[next].nodeKey)
          return [{ kind: "redraw" }]
        }
        if (key === "home" || key === "end") {
          nav.select(key === "home" ? list[0].nodeKey : list[list.length - 1].nodeKey)
          return [{ kind: "redraw" }]
        }
      }
    }
    switch (key) {
      case "up":
        return nav.up()
      case "down":
        return nav.down()
      case "right":
        return nav.right()
      case "left":
        return nav.left()
      case "enter":
        return nav.enter()
      case "escape":
        return nav.escape()
      case "home":
        return nav.home()
      case "end":
        return nav.end()
      case "tab":
        nav.nextTab(1)
        return [{ kind: "redraw" }]
      case "shiftTab":
        nav.nextTab(-1)
        return [{ kind: "redraw" }]
      default:
        return []
    }
  }

  dispose(): void {
    this.unsubscribe?.()
    this.visible = false
    this.requestRender = undefined
  }

  // ---- 内部 ----

  private onRuntimeEvent(event: WorkflowRuntimeEvent): void {
    // resume 复用同一 runId：run.started 表示新一代开始，旧树必须重建（否则上一代节点会残留混排）
    if (event.type === "run.started" && this.trees.has(event.runId)) {
      this.trees.delete(event.runId)
      if (this.activeRunId === event.runId) {
        this.ensureTree(event.runId)
        this.navigation.ensureSelection()
        this.requestRender?.()
      }
      return
    }
    const tree = this.trees.get(event.runId)
    if (!tree) {
      // 未打开过的 run：只在它是当前 run 时才建树（其它 run 打开时按快照重建）
      if (event.runId !== this.activeRunId) {
        if (event.type === "run.started") this.requestRender?.()
        return
      }
      this.ensureTree(event.runId)
    }
    const changed = this.trees.get(event.runId)?.applyEvent(event)
    if (changed && this.activeRunId === event.runId) this.requestRender?.()
  }

  /** 建树：优先用 RunManager 快照（不重放历史事件），之后靠增量事件推进 */
  private ensureTree(runId: string): WorkflowTreeModel {
    const existing = this.trees.get(runId)
    if (existing) return existing
    const snapshot = this.runManager.getSnapshot(runId)
    if (!snapshot) throw new Error(`run 不存在: ${runId}`)
    const tree = new WorkflowTreeModel(runId)
    tree.loadSnapshot(snapshot)
    this.trees.set(runId, tree)
    return tree
  }

  private pickDefaultRun(): string | undefined {
    const runs = this.runManager.list()
    const running = runs.find((r) => r.status === "running")
    return (running ?? runs[0])?.runId
  }

  private repo(): JournalDetailRepository {
    const cached = this.journalFor
    if (cached && cached.runId === this.activeRunId) return cached.repo
    const runId = this.activeRunId ?? ""
    const store = this.journalOverride ?? new JournalStore(this.cwd, this.journalDir)
    const repo = new JournalDetailRepository(store, runId)
    this.journalFor = { runId, repo }
    return repo
  }

  private runRows(): ExplorerRunRow[] {
    return this.runManager.list().map((r) => {
      const snap: RunSnapshot | null = this.runManager.getSnapshot(r.runId)
      const agents = snap?.agents ?? []
      return {
        runId: r.runId,
        label: r.label,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        workflows: snap?.workflows.length ?? 0,
        agentsTotal: agents.length,
        agentsDone: agents.filter((a) => a.status !== "running").length,
      }
    })
  }
}

/** nodeKey = [runId, kind, scopePath, localId].join("|")；agent 的 localId 即 journal key */
function localAgentId(nodeKey: string): string {
  const parts = nodeKey.split("|")
  return parts[parts.length - 1]
}
