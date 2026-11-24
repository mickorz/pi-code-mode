/**
 * WorkflowTreeModel —— Runtime 执行数据 → 统一执行树（M3）。
 *
 * 职责边界：只构建树与节点状态，不渲染、不执行操作、不依赖任何 TUI 库。
 *
 * 关键设计（对齐架构设计 §6）：
 *   1. 稳定身份：nodeKey = [runId, kind, scopePath, localId].join("|")，绝不用数组下标
 *      （对照 REF-001 selectionKey(runId, nodeId) 的教训：多并行 run 中同 id 节点不能互相覆盖）
 *   2. 父子关系：child workflow 按 scopePath 前缀挂载；agent/tool 按 phaseId 挂到 phase 下
 *      （无 phase 时退到所属 workflow）；composite 按 compositePath 嵌套
 *   3. 父节点晚到：先记入 pendingChildren，父节点创建时回挂（子 workflow 事件可能先于父到达）
 *   4. 并发排序：节点带 createdSequence（事件到达序），children 按它排序——并行 agent 完成快慢
 *      不会让树位置跳动
 */

import type { RunSnapshot } from "../../../manager/src/run-manager.js"
import type {
  AgentRecord,
  CompositeRecord,
  PhaseExecutionRecord,
  ToolExecutionRecord,
  WorkflowExecutionRecord,
} from "../../../engine/src/types/index.js"
import type { WorkflowRuntimeEvent } from "../../../engine/src/events/workflow-events.js"

export type WorkflowTreeNodeKind = "run" | "workflow" | "phase" | "agent" | "composite" | "tool"

export interface WorkflowTreeNode {
  nodeKey: string
  runId: string
  parentKey?: string
  kind: WorkflowTreeNodeKind
  label: string
  status: string
  scopePath: string[]
  startedAt?: number
  endedAt?: number
  durationMs?: number
  children: string[]
  createdSequence: number
  /** 事件最后一次触达的 sequence（诊断/去重用，不参与排序） */
  updatedSequence: number
  metadata?: {
    model?: string
    tokens?: number
    attempt?: number
    replayed?: boolean
    outputType?: string
    /** 节点快照的 2KB 结果预览（journal 未写入时的详情兜底） */
    outputPreview?: string
    /** 运行中的流式输出尾部（方案 B；仅展示，完成态后被 journal 结果取代） */
    partialOutput?: string
    error?: string
  }
}

/** 稳定节点身份（导出供测试与详情层对齐） */
export function makeNodeKey(runId: string, kind: WorkflowTreeNodeKind, scopePath: string[], localId: string): string {
  return [runId, kind, scopePath.join("/"), localId].join("|")
}

/** phaseId 与 Runtime 侧一致：`<scopePath.join("/")>#<display title>` */
export function makePhaseId(scopePath: string[], displayTitle: string): string {
  return `${scopePath.join("/")}#${displayTitle}`
}

function workflowNodeKey(runId: string, scopePath: string[]): string {
  return makeNodeKey(runId, "workflow", scopePath, "")
}

export class WorkflowTreeModel {
  private readonly nodes = new Map<string, WorkflowTreeNode>()
  /** 子节点先到、父节点未建时的待挂号：parentKey -> childKey[] */
  private readonly pendingChildren = new Map<string, string[]>()
  private readonly runId: string
  private runStatus = "running"
  private lastSequence = 0

  constructor(runId: string) {
    this.runId = runId
  }

  /** 运行状态（run 节点展示用；由 RunManager 快照同步） */
  setRunStatus(status: string): void {
    this.runStatus = status
    const runNode = this.nodes.get(this.runKey())
    if (runNode) runNode.status = status
  }

  /** 全量重建（首次挂载 / run 快照兜底）；事件流正常时不需要调用 */
  loadSnapshot(snapshot: RunSnapshot): void {
    this.nodes.clear()
    this.pendingChildren.clear()
    this.runStatus = snapshot.status
    this.lastSequence = 0
    this.ensureRunNode(snapshot.startedAt)
    for (const w of snapshot.workflows) this.upsertWorkflow(w, this.nextSeq())
    for (const p of snapshot.phases) this.upsertPhase(p, this.nextSeq())
    for (const c of snapshot.composites) this.upsertComposite(c, this.nextSeq())
    for (const t of snapshot.tools) this.upsertTool(t, this.nextSeq())
    for (const a of snapshot.agents) this.upsertAgent(a, this.nextSeq())
    this.lastSequence = snapshot.lastSequence
    this.resolvePending()
  }

  /** 增量应用一条 Runtime 事件；返回是否有可见变化（调用方决定是否重绘） */
  applyEvent(event: WorkflowRuntimeEvent): boolean {
    if (event.runId !== this.runId) return false
    if (event.sequence <= this.lastSequence) return false // 旧事件不回退状态
    this.lastSequence = event.sequence
    switch (event.type) {
      case "workflow.started":
      case "workflow.finished":
        this.upsertWorkflow(event.payload as WorkflowExecutionRecord, event.sequence)
        return true
      case "phase.started":
      case "phase.finished":
        this.upsertPhase(event.payload as PhaseExecutionRecord, event.sequence)
        return true
      case "agent.started":
      case "agent.updated":
      case "agent.finished":
        this.upsertAgent(event.payload as AgentRecord, event.sequence)
        return true
      case "composite.started":
      case "composite.finished":
        this.upsertComposite(event.payload as CompositeRecord, event.sequence)
        return true
      case "tool.started":
      case "tool.finished":
        this.upsertTool(event.payload as ToolExecutionRecord, event.sequence)
        return true
      case "run.finished":
        this.setRunStatus(String((event.payload as { status?: string } | undefined)?.status ?? "completed"))
        return true
      default:
        return false
    }
  }

  getNode(nodeKey: string): WorkflowTreeNode | undefined {
    return this.nodes.get(nodeKey)
  }

  /** 根节点 key（不存在时创建） */
  get rootKey(): string {
    return this.ensureRunNode()
  }

  size(): number {
    return this.nodes.size
  }

  /**
   * 是否有「会走字」的运行中节点（决定秒表 tick 是否需要真的重绘；折叠子树也算）。
   * 只算非 run 节点：run 节点的 running 不会带来可见变化（头部的计数本身不会自增），
   * 计入会让一个卡住的 run 永久 1s 重绘一次。
   */
  hasRunning(): boolean {
    for (const node of this.nodes.values()) {
      if (node.kind !== "run" && node.status === "running") return true
    }
    return false
  }

  /** 按树的深度优先展开顺序返回可见节点（不含已折叠子树；navigation 层负责折叠判定） */
  flatten(options?: { isExpanded?: (node: WorkflowTreeNode) => boolean }): WorkflowTreeNode[] {
    const isExpanded = options?.isExpanded ?? (() => true)
    const out: WorkflowTreeNode[] = []
    const walk = (key: string) => {
      const node = this.nodes.get(key)
      if (!node) return
      out.push(node)
      if (!isExpanded(node)) return
      for (const childKey of node.children) walk(childKey)
    }
    walk(this.rootKey)
    return out
  }

  /** 某节点的祖先链（近 → 远，不含自身） */
  ancestorsOf(nodeKey: string): WorkflowTreeNode[] {
    const out: WorkflowTreeNode[] = []
    let cur = this.nodes.get(nodeKey)?.parentKey
    while (cur) {
      const node = this.nodes.get(cur)
      if (!node) break
      out.push(node)
      cur = node.parentKey
    }
    return out
  }

  private nextSeq(): number {
    return ++this.lastSequence
  }

  private runKey(): string {
    return makeNodeKey(this.runId, "run", [], this.runId)
  }

  private ensureRunNode(startedAt?: number): string {
    const key = this.runKey()
    const existing = this.nodes.get(key)
    if (existing) return key
    // run 节点本身没有父节点；先建占位保证其他节点的挂载目标存在
    this.nodes.set(key, {
      nodeKey: key,
      runId: this.runId,
      kind: "run",
      label: this.runId,
      status: this.runStatus,
      scopePath: [],
      startedAt,
      children: [],
      createdSequence: 0,
      updatedSequence: 0,
    })
    this.resolvePending()
    return key
  }

  /** 建立节点（已存在则更新）；负责挂父与回挂待挂子节点 */
  private putNode(node: WorkflowTreeNode, parentKey: string): WorkflowTreeNode {
    const existing = this.nodes.get(node.nodeKey)
    if (existing) {
      // 保留创建序与子列表（子列表由挂载关系维护），其余字段以新事件为准
      existing.label = node.label || existing.label
      existing.status = node.status
      existing.startedAt = node.startedAt ?? existing.startedAt
      existing.endedAt = node.endedAt ?? existing.endedAt
      existing.durationMs = node.durationMs ?? existing.durationMs
      existing.metadata = { ...existing.metadata, ...node.metadata }
      existing.updatedSequence = node.updatedSequence
      if (existing.parentKey !== parentKey) {
        this.detachFromParent(existing)
        this.attachToParent(existing, parentKey)
      }
      return existing
    }
    this.nodes.set(node.nodeKey, node)
    this.attachToParent(node, parentKey)
    this.resolvePending()
    return node
  }

  private attachToParent(node: WorkflowTreeNode, parentKey: string): void {
    node.parentKey = parentKey
    const parent = this.nodes.get(parentKey)
    if (!parent) {
      // 父节点还没建：登记待挂，父节点创建时回挂（不丢节点）
      const list = this.pendingChildren.get(parentKey) ?? []
      if (!list.includes(node.nodeKey)) list.push(node.nodeKey)
      this.pendingChildren.set(parentKey, list)
      return
    }
    if (!parent.children.includes(node.nodeKey)) parent.children.push(node.nodeKey)
    this.sortChildren(parent)
  }

  private detachFromParent(node: WorkflowTreeNode): void {
    if (!node.parentKey) return
    const parent = this.nodes.get(node.parentKey)
    if (parent) parent.children = parent.children.filter((k) => k !== node.nodeKey)
  }

  /** 父节点创建后，把等待挂载的子节点接上（可级联：子节点的子节点由各自 resolve 处理） */
  private resolvePending(): void {
    let changed = true
    while (changed) {
      changed = false
      for (const [parentKey, childKeys] of [...this.pendingChildren]) {
        const parent = this.nodes.get(parentKey)
        if (!parent) continue
        for (const childKey of childKeys) {
          const child = this.nodes.get(childKey)
          if (!child) continue
          if (!parent.children.includes(childKey)) parent.children.push(childKey)
        }
        this.pendingChildren.delete(parentKey)
        this.sortChildren(parent)
        changed = true
      }
    }
  }

  private sortChildren(node: WorkflowTreeNode): void {
    node.children.sort((a, b) => {
      const na = this.nodes.get(a)?.createdSequence ?? 0
      const nb = this.nodes.get(b)?.createdSequence ?? 0
      return na - nb
    })
  }

  // ---- 各类节点的 upsert ----

  private upsertWorkflow(record: WorkflowExecutionRecord, seq: number): void {
    const scopePath = record.scopePath.length ? record.scopePath : ["root"]
    const key = workflowNodeKey(this.runId, scopePath)
    const parentKey = scopePath.length > 1 ? workflowNodeKey(this.runId, scopePath.slice(0, -1)) : this.ensureRunNode()
    this.putNode(
      {
        nodeKey: key,
        runId: this.runId,
        kind: "workflow",
        label: record.label || record.name,
        status: record.status,
        scopePath,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        durationMs: record.durationMs,
        children: [],
        createdSequence: seq,
        updatedSequence: seq,
        metadata: record.error ? { error: record.error } : undefined,
      },
      parentKey,
    )
  }

  private upsertPhase(record: PhaseExecutionRecord, seq: number): void {
    const scopePath = record.scopePath.length ? record.scopePath : ["root"]
    const key = makeNodeKey(this.runId, "phase", scopePath, record.title)
    this.putNode(
      {
        nodeKey: key,
        runId: this.runId,
        kind: "phase",
        label: record.title,
        status: record.status,
        scopePath,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        durationMs: record.durationMs,
        children: [],
        createdSequence: seq,
        updatedSequence: seq,
      },
      workflowNodeKey(this.runId, scopePath),
    )
  }

  private upsertAgent(record: AgentRecord, seq: number): void {
    const scopePath = record.workflowScopePath?.length ? record.workflowScopePath : ["root"]
    const key = makeNodeKey(this.runId, "agent", scopePath, record.id)
    // 隐含阶段：子 workflow 无显式 phase 时，Runtime 用 "▸ child / " 前缀当展示阶段（没有对应 phase 事件）。
    // 为不丢节点，这里按需建一个阶段节点占位（同 phaseId 与真实 phase.started 合并，不会重复）
    if (record.phase) this.ensureImplicitPhase(scopePath, record.phase, seq)
    const parentKey = record.phase
      ? makeNodeKey(this.runId, "phase", scopePath, record.phase)
      : workflowNodeKey(this.runId, scopePath)
    // 复合节点内的 agent 挂到 composite 下（顺序、fallback、race 的成员关系可见）
    const compositeParent = record.compositePath?.length
      ? makeNodeKey(this.runId, "composite", scopePath, record.compositePath.join("."))
      : parentKey
    this.putNode(
      {
        nodeKey: key,
        runId: this.runId,
        kind: "agent",
        label: record.label || record.id,
        status: record.status,
        scopePath,
        startedAt: record.startedAt ?? record.attemptStartedAt,
        durationMs: record.durationMs,
        children: [],
        createdSequence: seq,
        updatedSequence: seq,
        metadata: {
          model: record.model,
          tokens: record.tokens,
          attempt: record.attempt,
          replayed: record.replayed,
          outputType: record.outputType,
          outputPreview: record.outputPreview,
          partialOutput: record.partialOutput,
          error: record.error,
        },
      },
      compositeParent,
    )
  }

  private upsertComposite(record: CompositeRecord, seq: number): void {    const scopePath = record.scopePath.length ? record.scopePath : ["root"]
    const key = makeNodeKey(this.runId, "composite", scopePath, record.compositePath.join(".") || record.id)
    // 嵌套组合（cmp1 内含 cmp2）：父 = 上一级 composite，否则所属 workflow
    const parentKey =
      record.compositePath.length > 1
        ? makeNodeKey(this.runId, "composite", scopePath, record.compositePath.slice(0, -1).join("."))
        : workflowNodeKey(this.runId, scopePath)
    this.putNode(
      {
        nodeKey: key,
        runId: this.runId,
        kind: "composite",
        label: `${record.kind}: ${record.label}`,
        status: record.status,
        scopePath,
        startedAt: record.startedAt,
        durationMs: record.durationMs,
        children: [],
        createdSequence: seq,
        updatedSequence: seq,
      },
      parentKey,
    )
  }

  /** 隐含阶段节点（子 workflow 无显式 phase 时的展示前缀）；已存在则复用 */
  private ensureImplicitPhase(scopePath: string[], phaseLabel: string, seq: number): void {
    const key = makeNodeKey(this.runId, "phase", scopePath, phaseLabel)
    if (this.nodes.has(key)) return
    this.putNode(
      {
        nodeKey: key,
        runId: this.runId,
        kind: "phase",
        label: phaseLabel.trim(),
        status: "running",
        scopePath,
        children: [],
        createdSequence: seq,
        updatedSequence: seq,
      },
      workflowNodeKey(this.runId, scopePath),
    )
  }

  private upsertTool(record: ToolExecutionRecord, seq: number): void {
    const scopePath = record.scopePath.length ? record.scopePath : ["root"]
    const key = makeNodeKey(this.runId, "tool", scopePath, record.toolId)
    const parentKey = record.phase
      ? makeNodeKey(this.runId, "phase", scopePath, record.phase)
      : workflowNodeKey(this.runId, scopePath)
    this.putNode(
      {
        nodeKey: key,
        runId: this.runId,
        kind: "tool",
        label: `${record.kind === "mcp" ? "[mcp] " : "[tool] "}${record.name}`,
        status: record.status,
        scopePath,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        durationMs: record.durationMs,
        children: [],
        createdSequence: seq,
        updatedSequence: seq,
        metadata: record.error ? { error: record.error } : undefined,
      },
      parentKey,
    )
  }
}
