/**
 * Call Graph + 依赖分析（M1-T2）
 *
 * 输入：ast-parser 的 nodes/edges
 * 输出：
 *  - 调用图（节点 + 带置信度的边）
 *  - 并行候选（仅 Candidate 且无 Unknown/动态风险）
 *  - 波次估算（并行容器内的 agent 数 / concurrency）
 */
import type { AstAnalysis, CallNode, DependencyConfidence, DependencyEdge } from "./ast-parser.js"

export interface CallGraphNode {
  id: string
  kind: CallNode["kind"]
  line: number
  endLine: number
  label: string
  dynamic: boolean
  containerId?: string
  promptPreview?: string
  scriptPath?: string
}

export interface CallGraph {
  nodes: CallGraphNode[]
  edges: DependencyEdge[]
  /** 顶层顺序（源码序）agent/workflow 调用 id */
  order: string[]
  counts: Record<string, number>
  /** 动态调用数（Unknown 置信度来源） */
  dynamicCount: number
}

function labelOf(n: CallNode): string {
  if (n.scriptPath) return `${n.kind}(${n.scriptPath})`
  if (n.promptPreview) return `${n.kind}("${n.promptPreview.slice(0, 32)}")`
  return n.kind
}

export function buildCallGraph(ast: AstAnalysis): CallGraph {
  const counts: Record<string, number> = {}
  for (const n of ast.nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1
  return {
    nodes: ast.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      line: n.startLine,
      endLine: n.endLine,
      label: labelOf(n),
      dynamic: n.dynamic,
      ...(n.containerId ? { containerId: n.containerId } : {}),
      ...(n.promptPreview ? { promptPreview: n.promptPreview } : {}),
      ...(n.scriptPath ? { scriptPath: n.scriptPath } : {}),
    })),
    edges: ast.edges,
    order: ast.nodes.filter((n) => n.kind === "agent" || n.kind === "workflow").map((n) => n.id),
    counts,
    dynamicCount: ast.nodes.filter((n) => n.dynamic).length,
  }
}

export interface ParallelCandidate {
  /** 候选组：组内调用无 Explicit 依赖，可考虑并行 */
  ids: string[]
  lines: number[]
  reason: string
  /** 风险提示（置信度不足的原因） */
  risk?: string
}

export interface DependencySummary {
  /** 真串行链（Explicit 边构成的线性链） */
  serialChains: string[][]
  /** 并行候选（Candidate 边连接，无 Explicit 交叉） */
  candidates: ParallelCandidate[]
  /** Unknown：动态上下文，静态不可判定，禁用自动并行建议 */
  unknowns: Array<{ id: string; line: number; reason: string }>
  /** 边按置信度统计 */
  byConfidence: Record<DependencyConfidence, number>
}

export function analyzeDependencies(ast: AstAnalysis, graph: CallGraph): DependencySummary {
  const byConfidence: Record<DependencyConfidence, number> = { Explicit: 0, Structural: 0, Candidate: 0, Unknown: 0 }
  for (const e of ast.edges) byConfidence[e.confidence]++

  const nodesById = new Map(ast.nodes.map((n) => [n.id, n]))

  // 串行链：沿 Explicit 边做链式归并（from → to）
  const succ = new Map<string, string[]>()
  for (const e of ast.edges.filter((x) => x.confidence === "Explicit")) {
    succ.set(e.from, [...(succ.get(e.from) ?? []), e.to])
  }
  const hasExplicitIn = new Set(ast.edges.filter((x) => x.confidence === "Explicit").map((x) => x.to))
  const serialChains: string[][] = []
  const visited = new Set<string>()
  for (const start of [...succ.keys()].filter((k) => !hasExplicitIn.has(k))) {
    const chain: string[] = []
    let cur: string | undefined = start
    while (cur && !visited.has(cur)) {
      visited.add(cur)
      chain.push(cur)
      const next: string[] | undefined = succ.get(cur)?.filter((n: string) => !visited.has(n))
      cur = next?.[0]
    }
    if (chain.length > 1) serialChains.push(chain)
  }

  // 并行候选：Candidate 边连接的组；排除动态与 Explicit 参与的节点
  const explicitNodes = new Set(ast.edges.filter((e) => e.confidence === "Explicit").flatMap((e) => [e.from, e.to]))
  const candEdges = ast.edges.filter((e) => e.confidence === "Candidate")
  const groups: string[][] = []
  const seen = new Set<string>()
  for (const e of candEdges) {
    if (seen.has(e.from) && seen.has(e.to)) continue
    const group = groups.find((g) => g.includes(e.from) || g.includes(e.to))
    if (group) {
      for (const id of [e.from, e.to]) if (!group.includes(id)) group.push(id)
    } else {
      groups.push([e.from, e.to])
    }
    seen.add(e.from)
    seen.add(e.to)
  }
  const candidates: ParallelCandidate[] = groups
    .filter((g) => g.length >= 2)
    .map((g) => {
      const risky = g.filter((id) => {
        const n = nodesById.get(id)
        return !n || n.dynamic || explicitNodes.has(id)
      })
      return {
        ids: g,
        lines: g.map((id) => nodesById.get(id)?.startLine ?? 0),
        reason: "源码顺序相邻但无数据引用（Candidate 置信度）",
        ...(risky.length ? { risk: `组内含动态或存在 Explicit 依赖的节点：${risky.join(",")}——需语义确认后才可并行化` } : {}),
      }
    })

  const unknowns = ast.nodes
    .filter((n) => n.dynamic)
    .map((n) => ({
      id: n.id,
      line: n.startLine,
      reason: n.loopBounds?.reason ?? "动态上下文，静态不可判定",
    }))

  return { serialChains, candidates, unknowns, byConfidence }
}
