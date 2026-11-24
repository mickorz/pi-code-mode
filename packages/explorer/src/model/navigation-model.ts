/**
 * ExplorerNavigationState / NavigationModel —— 导航状态机。
 *
 * 交互模型对齐 REF-001（opencode-dynamic-workflows）：**单树 + 全屏详情两态**，无 Tab。
 *   view = "tree"   执行树（唯一入口视图）
 *   view = "detail" 当前节点的全屏详情（opencode 的 node detail route 等价物）
 *
 * 双状态分离（架构设计 §4.2）：导航状态（选中/折叠）与展示状态（详情滚动）互不覆盖，
 * 后台事件刷新不会抢走焦点。
 *
 * 键位（2026-11-18 二次调整，按使用者反馈）：
 *   tree:   ↑/k ↓/j 选择   PgUp/PgDn 翻页选择   → 展开（已展开则进首个子节点）
 *           ← 收起/回父级   Enter/o 打开详情   Home/End 首/末节点   Esc/q/^B 关闭
 *   detail: PgUp/PgDn 滚动   ↑ 返回树   ←/→ 上一个/下一个节点   Esc/q 返回树
 *
 * 纯状态机：不依赖 TUI，输入是逻辑键名（keys.ts 归一化后的 up/down/left/right/enter/escape/home/end/o）。
 */

import type { WorkflowTreeNode } from "./workflow-tree-model.js"

/** 全屏视图态（B2：两个视图满屏切换，不再有 Tab 与分栏） */
export type ExplorerView = "tree" | "detail"

export type NavigationEffect =
  | { kind: "redraw" }
  | { kind: "close" }
  /** 详情数据加载（Agent → journal 读取；同步实现，保留 effect 便于将来异步化） */
  | { kind: "load-detail"; nodeKey: string }

export interface ExplorerNavigationState {
  selectedNodeKey?: string
  /** 显式收起的节点（缺省全部展开：运行中的树通常只有几十个节点，默认展开信息量更大） */
  collapsedNodeKeys: Set<string>
  view: ExplorerView
  detailScrollTop: number
  /** 详情内容的最大滚动起点（渲染层回报；End/PgDn 用它钳制，避免越界白屏） */
  detailMaxScroll: number
  /** 翻页步长（渲染层按视口行数回报；PgUp/PgDn 与 Home/End 用） */
  pageSize: number
}

export interface NavigationHost {
  /** 当前 run 的可见节点（深度优先 + 展开态过滤由本模型负责） */
  rootKey(): string
  node(key: string): WorkflowTreeNode | undefined
}

export class NavigationModel {
  state: ExplorerNavigationState = {
    collapsedNodeKeys: new Set<string>(),
    view: "tree",
    detailScrollTop: 0,
    detailMaxScroll: 0,
    pageSize: 10,
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

  /** 节点被删除/不可达时回退到有效节点（架构设计 §9.3） */
  pruneSelection(): void {
    if (!this.state.selectedNodeKey) return
    if (this.host.node(this.state.selectedNodeKey)) return
    this.state.selectedNodeKey = this.host.rootKey()
  }

  select(nodeKey: string): void {
    this.state.selectedNodeKey = nodeKey
    this.state.detailScrollTop = 0
    this.state.detailMaxScroll = 0
  }

  // ---- 按键动作（返回需要宿主配合的 effect）----

  /** ↑/k ：树里上移；**详情态回树**（滚动改用 PgUp/PgDn） */
  up(): NavigationEffect[] {
    if (this.state.view === "detail") return this.escape()
    return this.moveSelection(-1)
  }

  down(): NavigationEffect[] {
    if (this.state.view === "detail") return [{ kind: "redraw" }]
    return this.moveSelection(1)
  }

  /** PgUp/PgDn ：详情态按视口翻页滚动；树里按页移动选中 */
  pageUp(): NavigationEffect[] {
    if (this.state.view === "detail") return this.scrollDetail(-this.state.pageSize)
    return this.moveSelection(-this.state.pageSize)
  }

  pageDown(): NavigationEffect[] {
    if (this.state.view === "detail") return this.scrollDetail(this.state.pageSize)
    return this.moveSelection(this.state.pageSize)
  }

  home(): NavigationEffect[] {
    if (this.state.view === "detail") {
      this.state.detailScrollTop = 0
      return [{ kind: "redraw" }]
    }
    const rows = this.visibleRows()
    if (rows.length) this.select(rows[0].nodeKey)
    return [{ kind: "redraw" }]
  }

  end(): NavigationEffect[] {
    if (this.state.view === "detail") {
      this.state.detailScrollTop = this.state.detailMaxScroll
      return [{ kind: "redraw" }]
    }
    const rows = this.visibleRows()
    if (rows.length) this.select(rows[rows.length - 1].nodeKey)
    return [{ kind: "redraw" }]
  }

  /** → ：树里展开（已展开则进首个子节点）；详情态切到下一个节点 */
  right(): NavigationEffect[] {
    if (this.state.view === "detail") return this.moveSelection(1)
    return this.expandOrEnterChild()
  }

  /** ← ：收起或回父级；详情态切到上一个节点 */
  left(): NavigationEffect[] {
    if (this.state.view === "detail") return this.moveSelection(-1)
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

  /** Enter ：打开当前节点的全屏详情（与 o 同义；展开由 → 负责） */
  enter(): NavigationEffect[] {
    return this.openDetail()
  }

  /** o ：打开当前节点的全屏详情（opencode 的 node detail route） */
  openDetail(): NavigationEffect[] {
    const node = this.selectedNode
    if (!node) return [{ kind: "redraw" }]
    this.state.view = "detail"
    this.state.detailScrollTop = 0
    this.state.detailMaxScroll = 0
    return [{ kind: "redraw" }, { kind: "load-detail", nodeKey: node.nodeKey }]
  }

  /** Esc / q ：详情 → 树；树 → 关闭面板（由 Controller 决定 close 语义） */
  escape(): NavigationEffect[] {
    if (this.state.view === "detail") {
      this.state.view = "tree"
      return [{ kind: "redraw" }]
    }
    return [{ kind: "close" }]
  }

  scrollDetail(delta: number): NavigationEffect[] {
    // 越界的旧值先钳到合法区间（内容变短 / End 后再按 ↑ 都从真实末尾回退）
    const base = Math.min(this.state.detailScrollTop, this.state.detailMaxScroll)
    this.state.detailScrollTop = Math.min(this.state.detailMaxScroll, Math.max(0, base + delta))
    return [{ kind: "redraw" }]
  }

  /** 渲染层回报视口行数（翻页步长） */
  setPageSize(rows: number): void {
    const size = Math.max(1, Math.trunc(rows) || 1)
    this.state.pageSize = size
  }

  /** 渲染层回报详情内容的最大滚动起点（内容行数 - 视口行数） */
  setDetailMaxScroll(maxStart: number): void {
    this.state.detailMaxScroll = Math.max(0, Math.trunc(maxStart) || 0)
    if (this.state.detailScrollTop > this.state.detailMaxScroll) {
      this.state.detailScrollTop = this.state.detailMaxScroll
    }
  }

  private expandOrEnterChild(): NavigationEffect[] {
    const node = this.selectedNode
    if (!node) return [{ kind: "redraw" }]
    if (!node.children.length) return [{ kind: "redraw" }]
    if (this.state.collapsedNodeKeys.has(node.nodeKey)) {
      this.state.collapsedNodeKeys.delete(node.nodeKey)
      return [{ kind: "redraw" }]
    }
    const first = node.children[0]
    if (first) this.select(first)
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
