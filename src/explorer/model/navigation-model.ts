/**
 * ExplorerNavigationState / NavigationModel —— 导航状态机（M4）。
 *
 * 双状态分离（架构设计 §4.2 / §9）：
 *   - 导航状态（selectedNodeKey / expandedNodeKeys / focus）：用户在看哪
 *   - 展示状态（detailScrollTop / detailContentKey）：详情区在展示什么
 * 两者不混为一个字段，否则后台事件刷新会与用户跨节点切换互相打架。
 *
 * 纯状态机：不依赖 TUI，输入是逻辑键名（keys.ts 归一化后的 up/down/left/right/enter/escape/tab/home/end）。
 */

import type { WorkflowTreeNode } from "./workflow-tree-model.js"

export type ExplorerTab = "workflow" | "agents" | "tools" | "journal"
export const EXPLORER_TABS: ExplorerTab[] = ["workflow", "agents", "tools", "journal"]

export type ExplorerFocus = "tree" | "detail"

export type NavigationEffect =
  | { kind: "redraw" }
  | { kind: "close" }
  /** 详情数据需要异步加载（Agent → journal 读取） */
  | { kind: "load-detail"; nodeKey: string }

export interface ExplorerNavigationState {
  activeTab: ExplorerTab
  selectedNodeKey?: string
  /** 显式收起的节点（缺省全部展开：运行中的树通常只有几十个节点，默认展开信息量更大） */
  collapsedNodeKeys: Set<string>
  focus: ExplorerFocus
  detailScrollTop: number
}

export interface NavigationHost {
  /** 当前 run 的可见节点（深度优先 + 展开态过滤由本模型负责） */
  rootKey(): string
  node(key: string): WorkflowTreeNode | undefined
}

export class NavigationModel {
  state: ExplorerNavigationState = {
    activeTab: "workflow",
    collapsedNodeKeys: new Set<string>(),
    focus: "tree",
    detailScrollTop: 0,
  }

  constructor(private readonly host: NavigationHost) {}

  /** 可见行（树展开序）；折叠节点的子树被裁掉 */
  visibleRows(): WorkflowTreeNode[] {
    const rows: WorkflowTreeNode[] = []
    const walk = (key: string) => {
      const node = this.host.node(key)
      if (!node) return
      rows.push(node)
      if (node.children.length && this.state.collapsedNodeKeys.has(key)) return
      for (const child of node.children) walk(child)
    }
    walk(this.host.rootKey())
    return rows
  }

  /** 选中节点的索引；未选中时 -1 */
  selectedIndex(rows = this.visibleRows()): number {
    if (!this.state.selectedNodeKey) return -1
    return rows.findIndex((r) => r.nodeKey === this.state.selectedNodeKey)
  }

  get selectedNode(): WorkflowTreeNode | undefined {
    return this.state.selectedNodeKey ? this.host.node(this.state.selectedNodeKey) : undefined
  }

  /** 首次打开：默认选中根下的第一个 workflow（而不是 run 节点，信息量更大） */
  ensureSelection(): void {
    if (this.selectedNode) return
    const root = this.host.node(this.host.rootKey())
    this.state.selectedNodeKey = root?.children[0] ?? this.host.rootKey()
  }

  /** 节点被删除/不可达时回退到最近的有效父节点（架构设计 §9.3） */
  pruneSelection(): void {
    if (!this.state.selectedNodeKey) return
    if (this.host.node(this.state.selectedNodeKey)) return
    this.state.selectedNodeKey = this.host.rootKey()
  }

  select(nodeKey: string): void {
    this.state.selectedNodeKey = nodeKey
    this.state.detailScrollTop = 0
  }

  setTab(tab: ExplorerTab): void {
    this.state.activeTab = tab
    this.state.focus = "tree"
    this.state.detailScrollTop = 0
  }

  nextTab(dir: 1 | -1): void {
    const idx = EXPLORER_TABS.indexOf(this.state.activeTab)
    const next = (idx + dir + EXPLORER_TABS.length) % EXPLORER_TABS.length
    this.setTab(EXPLORER_TABS[next])
  }

  // ---- 按键动作（返回需要宿主配合的 effect）----

  up(): NavigationEffect[] {
    if (this.state.focus === "detail") return this.scrollDetail(-1)
    return this.moveSelection(-1)
  }

  down(): NavigationEffect[] {
    if (this.state.focus === "detail") return this.scrollDetail(1)
    return this.moveSelection(1)
  }

  home(): NavigationEffect[] {
    if (this.state.focus === "detail") {
      this.state.detailScrollTop = 0
      return [{ kind: "redraw" }]
    }
    const rows = this.visibleRows()
    if (rows.length) this.select(rows[0].nodeKey)
    return [{ kind: "redraw" }]
  }

  end(): NavigationEffect[] {
    if (this.state.focus === "detail") {
      this.state.detailScrollTop = Number.MAX_SAFE_INTEGER
      return [{ kind: "redraw" }]
    }
    const rows = this.visibleRows()
    if (rows.length) this.select(rows[rows.length - 1].nodeKey)
    return [{ kind: "redraw" }]
  }

  /** → ：树模式下展开子节点；无子节点则进入详情。详情模式下切换到下一个节点 */
  right(): NavigationEffect[] {
    if (this.state.focus === "detail") return this.moveSelection(1)
    const node = this.selectedNode
    if (!node) return [{ kind: "redraw" }]
    if (node.children.length) {
      if (this.state.collapsedNodeKeys.has(node.nodeKey)) {
        this.state.collapsedNodeKeys.delete(node.nodeKey)
      } else {
        // 已展开：进入第一个子节点
        const first = node.children[0]
        if (first) this.select(first)
      }
      return [{ kind: "redraw" }]
    }
    return this.enter()
  }

  /** ← ：收起或回到父级；详情模式切换到上一个节点 */
  left(): NavigationEffect[] {
    if (this.state.focus === "detail") return this.moveSelection(-1)
    const node = this.selectedNode
    if (!node) return [{ kind: "redraw" }]
    if (node.children.length && !this.state.collapsedNodeKeys.has(node.nodeKey)) {
      this.state.collapsedNodeKeys.add(node.nodeKey)
      return [{ kind: "redraw" }]
    }
    if (node.parentKey) {
      this.select(node.parentKey)
      return [{ kind: "redraw" }]
    }
    return [{ kind: "redraw" }]
  }

  /** Enter ：进入详情 */
  enter(): NavigationEffect[] {
    const node = this.selectedNode
    if (!node) return [{ kind: "redraw" }]
    if (node.children.length) this.state.collapsedNodeKeys.delete(node.nodeKey)
    this.state.focus = "detail"
    this.state.detailScrollTop = 0
    return [{ kind: "redraw" }, { kind: "load-detail", nodeKey: node.nodeKey }]
  }

  /** Esc ：详情 → 树；树 → 关闭面板（由 Controller 决定 close 语义） */
  escape(): NavigationEffect[] {
    if (this.state.focus === "detail") {
      this.state.focus = "tree"
      return [{ kind: "redraw" }]
    }
    return [{ kind: "close" }]
  }

  scrollDetail(delta: number): NavigationEffect[] {
    const next = Math.max(0, this.state.detailScrollTop + delta)
    this.state.detailScrollTop = next
    return [{ kind: "redraw" }]
  }

  private moveSelection(delta: number): NavigationEffect[] {
    const rows = this.visibleRows()
    if (!rows.length) return [{ kind: "redraw" }]
    const idx = this.selectedIndex(rows)
    if (idx < 0) {
      this.select(rows[0].nodeKey)
      return [{ kind: "redraw" }]
    }
    const next = Math.min(rows.length - 1, Math.max(0, idx + delta))
    if (next !== idx) this.select(rows[next].nodeKey)
    return [{ kind: "redraw" }]
  }
}
