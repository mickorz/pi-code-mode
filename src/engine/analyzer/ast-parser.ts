/**
 * AST Analyzer（M1-T2）
 *
 * 职责边界（架构基线 3.2 + 陷阱 2）：
 *  - 只做静态可确定的事实；动态循环输出动态节点+可确定上下界，动态分发标 Unknown
 *  - 依赖边必须带置信度：Explicit / Structural / Candidate / Unknown
 *  - 不伪造无法静态推断的数据（不为了 100% 识别率编造调用数）
 *
 * 复用 vm.ts 同一 Acorn 依赖与解析选项（顶层 await / return）。
 */
import { parse } from "acorn"

export type NodeKind =
  | "agent"
  | "parallel"
  | "pipeline"
  | "sequence"
  | "fallback"
  | "race"
  | "workflow"
  | "mcp.call"
  | "runTool"
  | "checkpoint"
  | "verify"
  | "judgePanel"
  | "retry"

export type DependencyConfidence = "Explicit" | "Structural" | "Candidate" | "Unknown"

export interface CallNode {
  /** 稳定 id（按源码出现顺序，如 call-3） */
  id: string
  kind: NodeKind
  /** 1-based 行号区间 */
  startLine: number
  endLine: number
  /** 该调用内引用到的此前调用 id（用于 Explicit 依赖判定） */
  references: string[]
  /** 引用到的顶层标识符（含无法归类为调用的变量） */
  referencedIdentifiers: string[]
  /** 是否在动态上下文内（循环/动态分发），动态时 confidence=Unknown */
  dynamic: boolean
  /** 动态循环的可确定上下界（无法确定则 undefined） */
  loopBounds?: { min: number; max?: number; reason?: string }
  /** 所属 parallel/sequence/fallback/race 容器 id（若有） */
  containerId?: string
  /** 字面量 prompt 预览（截断） */
  promptPreview?: string
  /** workflow 子流程路径（字面量时） */
  scriptPath?: string
}

export interface DependencyEdge {
  from: string
  to: string
  confidence: DependencyConfidence
  reason: string
}

export interface AstAnalysis {
  nodes: CallNode[]
  edges: DependencyEdge[]
  /** 动态分发/动态上下文的 Unknown 位置（不可自动采纳） */
  unknowns: Array<{ line: number; reason: string }>
  /** 解析期提示（语法问题等） */
  diagnostics: string[]
}

const TRACKED: Record<string, NodeKind> = {
  agent: "agent",
  parallel: "parallel",
  pipeline: "pipeline",
  sequence: "sequence",
  fallback: "fallback",
  race: "race",
  workflow: "workflow",
  runTool: "runTool",
  checkpoint: "checkpoint",
  verify: "verify",
  judgePanel: "judgePanel",
  retry: "retry",
}

type AnyNode = any

function lineOf(node: AnyNode, lines: number[]): number {
  const offset = node.start as number
  let lo = 0
  let hi = lines.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lines[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** 收集子树内出现的标识符（排除属性名） */
function collectIdentifiers(node: AnyNode, out: Set<string>): void {
  if (!node || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const child of node) collectIdentifiers(child, out)
    return
  }
  if (node.type === "Identifier" && typeof node.name === "string") out.add(node.name)
  if (node.type === "Property" && node.value) return collectIdentifiers(node.value, out)
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue
    const value = node[key]
    if (value && typeof value === "object") collectIdentifiers(value, out)
  }
}

/** 提取变量声明名（`const a = await agent(...)` → a） */
function declaredName(stmt: AnyNode): string | undefined {
  if (stmt?.type === "VariableDeclaration" && stmt.declarations?.length === 1) {
    const id = stmt.declarations[0]?.id
    if (id?.type === "Identifier") return id.name
  }
  return undefined
}

/** 字面量字符串（模板字符串仅当无表达式时） */
function literalString(node: AnyNode): string | undefined {
  if (!node) return undefined
  if (node.type === "Literal" && typeof node.value === "string") return node.value
  if (node.type === "TemplateLiteral" && (node.expressions?.length ?? 0) === 0) {
    return (node.quasis ?? []).map((q: AnyNode) => q.value?.cooked ?? "").join("")
  }
  return undefined
}

export function analyzeAst(source: string): AstAnalysis {
  const nodes: CallNode[] = []
  const edges: DependencyEdge[] = []
  const unknowns: Array<{ line: number; reason: string }> = []
  const diagnostics: string[] = []

  let ast: AnyNode
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    })
  } catch (e) {
    diagnostics.push(`Acorn 解析失败：${String((e as Error)?.message ?? e)}`)
    return { nodes, edges, unknowns, diagnostics }
  }

  const lineStarts: number[] = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1)

  // 顶层顺序遍历语句（保持源码顺序）
  let seq = 0
  /** 变量名 → 产生它的调用 id（供 Explicit 依赖判定） */
  const varToCall = new Map<string, string>()
  /** 变量名 → 是否为动态调用目标（赋值为计算成员/成员访问/其他函数值） */
  const dynamicCallables = new Set<string>()
  /** 当前所在的动态上下文（循环/动态分发） */
  const dynamicStack: Array<{ reason: string; bounds?: CallNode["loopBounds"] }> = []
  /** 当前复合容器栈（parallel/sequence/...） */
  const containerStack: string[] = []

  const visitExpr = (expr: AnyNode, containerId?: string): void => {
    if (!expr || typeof expr !== "object") return
    if (Array.isArray(expr)) {
      for (const e of expr) visitExpr(e, containerId)
      return
    }
    // await X(...) / X(...)
    let callNode: AnyNode | undefined
    if (expr.type === "AwaitExpression") callNode = expr.argument
    else if (expr.type === "CallExpression") callNode = expr
    if (callNode?.type === "CallExpression") {
      const callee = callNode.callee
      const fnName =
        callee?.type === "Identifier"
          ? callee.name
          : callee?.type === "MemberExpression" && !callee.computed && callee.object?.name === "mcp"
            ? `mcp.${callee.property?.name}`
            : undefined
      // mcp.call 单独追踪
      const kind: NodeKind | undefined = fnName === "mcp.call" ? "mcp.call" : fnName ? TRACKED[fnName] : undefined
      if (kind) {
        const id = `call-${++seq}`
        const dyn = dynamicStack.at(-1)
        const referenced = new Set<string>()
        for (const arg of callNode.arguments ?? []) collectIdentifiers(arg, referenced)
        const refsRaw = [...referenced].filter((n) => varToCall.has(n))
        const refCalls = refsRaw.map((n) => varToCall.get(n)!)

        const node: CallNode = {
          id,
          kind,
          startLine: lineOf(callNode, lineStarts),
          endLine: lineOf({ start: callNode.end }, lineStarts),
          references: refCalls,
          referencedIdentifiers: [...referenced],
          dynamic: Boolean(dyn),
          ...(dyn?.bounds ? { loopBounds: dyn.bounds } : {}),
          ...(containerId ? { containerId } : {}),
        }
        // prompt 预览 / workflow 路径
        const firstArg = callNode.arguments?.[0]
        if (kind === "workflow") {
          const p =
            literalString(firstArg) ??
            literalString(firstArg?.properties?.find?.((p: AnyNode) => p.key?.name === "scriptPath")?.value)
          if (p) node.scriptPath = p
        } else if (kind === "agent") {
          const p = literalString(firstArg)
          if (p) node.promptPreview = p.slice(0, 80)
        }
        nodes.push(node)

        // 依赖边：引用了哪些先前调用
        for (const fromId of refCalls) {
          edges.push({
            from: fromId,
            to: id,
            confidence: "Explicit",
            reason: `prompt/参数引用了 ${refsRaw.join(",")}`,
          })
        }
        // 容器内结构依赖（parallel/sequence 内的兄弟顺序不构成依赖；仅记录容器归属）
        if (!refCalls.length && containerId) {
          edges.push({ from: containerId, to: id, confidence: "Structural", reason: "位于复合容器内" })
        }

        if (dyn) {
          unknowns.push({ line: node.startLine, reason: `${kind} 处于动态上下文：${dyn.reason}` })
        }

        // 复合容器的子调用继续遍历其参数（parallel 的 thunks 等）
        if (["parallel", "pipeline", "sequence", "fallback", "race"].includes(kind)) {
          containerStack.push(id)
          for (const arg of callNode.arguments ?? []) visitExpr(arg, id)
          containerStack.pop()
        } else {
          for (const arg of callNode.arguments ?? []) visitExpr(arg, containerId)
        }
        return
      }
      // 动态分发：callee 是计算成员访问（handlers[type]）或调用来自运行时值 → Unknown（静态不可判定）
      if (
        callee?.type === "MemberExpression" &&
        callee.computed === true
      ) {
        unknowns.push({
          line: lineOf(callNode, lineStarts),
          reason: `动态分发 ${String(callee.object?.name ?? "?")}[${String(callee.property?.name ?? "...")}]：调用目标静态不可判定`,
        })
      } else if (callee?.type === "Identifier" && dynamicCallables.has(callee.name)) {
        unknowns.push({
          line: lineOf(callNode, lineStarts),
          reason: `动态分发 ${callee.name}(...)：该变量由运行时值赋值，调用目标静态不可判定`,
        })
      } else if (callee?.type === "Identifier" && !TRACKED[callee.name]) {
        // 变量被赋值过函数/动态对象时（如 const handler = handlers[type]）无法确认
        // 只在同一作用域出现计算成员赋值时提示（保守：不猜测，仅记录一次）
      }
      // 非追踪调用（handler(...) 等）仍要下探
      visitExpr(callNode.callee, containerId)
      for (const arg of callNode.arguments ?? []) visitExpr(arg, containerId)
      return
    }
    for (const key of Object.keys(expr)) {
      if (["type", "start", "end", "loc", "range"].includes(key)) continue
      const v = expr[key]
      if (v && typeof v === "object") visitExpr(v, containerId)
    }
  }

  const visitStmt = (stmt: AnyNode): void => {
    if (!stmt || typeof stmt !== "object") return
    switch (stmt.type) {
      case "ForOfStatement":
      case "ForInStatement": {
        // 尝试从 `for (const x of new Array(48)/[...])` 推断上界
        const right = stmt.right
        let bound: number | undefined
        if (right?.type === "NewExpression" && right.callee?.name === "Array" && typeof right.arguments?.[0]?.value === "number") {
          bound = right.arguments[0].value
        } else if (right?.type === "ArrayExpression" && Array.isArray(right.elements)) {
          bound = right.elements.length
        }
        dynamicStack.push({
          reason: `${stmt.type} 循环迭代次数静态不可知`,
          bounds: bound !== undefined ? { min: 0, max: bound, reason: `迭代集合静态长度 ${bound}` } : { min: 0, reason: "迭代集合大小静态不可知" },
        })
        visitStmt(stmt.body)
        dynamicStack.pop()
        return
      }
      case "ForStatement":
        dynamicStack.push({
          reason: "for 循环次数静态不可知",
          bounds: { min: 0, reason: "循环边界依赖运行时值" },
        })
        visitStmt(stmt.body)
        dynamicStack.pop()
        return
      case "WhileStatement":
      case "DoWhileStatement":
        dynamicStack.push({ reason: "while 循环次数静态不可知", bounds: { min: 0, reason: "条件依赖运行时值" } })
        visitStmt(stmt.body)
        dynamicStack.pop()
        return
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        // 函数体内视为动态上下文（调用次数不可知）
        dynamicStack.push({ reason: "函数体执行次数静态不可知", bounds: { min: 0, reason: "调用方决定" } })
        visitStmt(stmt.body)
        dynamicStack.pop()
        return
      case "VariableDeclaration": {
        const name = declaredName(stmt)
        const init = stmt.declarations?.[0]?.init
        const before = nodes.length
        visitExpr(init)
        if (name && nodes.length > before) varToCall.set(name, nodes[nodes.length - 1]!.id)
        // 动态调用目标：计算成员访问 handlers[type]、成员访问 obj.fn、或非追踪函数的调用结果
        if (name && init && typeof init === "object") {
          const isDynamicValue =
            (init.type === "MemberExpression" && init.computed === true) ||
            init.type === "MemberExpression" ||
            init.type === "CallExpression" ||
            init.type === "ConditionalExpression"
          if (isDynamicValue && nodes.length === before) dynamicCallables.add(name)
        }
        return
      }
      case "ExpressionStatement":
        visitExpr(stmt.expression)
        return
      case "ReturnStatement":
        visitExpr(stmt.argument)
        return
      case "IfStatement":
        visitStmt(stmt.test)
        visitStmt(stmt.consequent)
        if (stmt.alternate) visitStmt(stmt.alternate)
        return
      case "BlockStatement":
        for (const s of stmt.body ?? []) visitStmt(s)
        return
      case "ExportNamedDeclaration":
        if (stmt.declaration) visitStmt(stmt.declaration)
        return
      case "TryStatement":
        visitStmt(stmt.block)
        if (stmt.handler) visitStmt(stmt.handler.body)
        if (stmt.finalizer) visitStmt(stmt.finalizer)
        return
      default: {
        // 兜底：下探所有对象字段
        for (const key of Object.keys(stmt)) {
          if (["type", "start", "end", "loc", "range"].includes(key)) continue
          const v = stmt[key]
          if (v && typeof v === "object") {
            if (Array.isArray(v)) for (const x of v) visitStmt(x)
            else if (typeof v.type === "string") visitStmt(v)
          }
        }
      }
    }
  }

  for (const stmt of ast.body ?? []) visitStmt(stmt)

  // 顺序候选：无 Explicit 边、且不在同一容器的相邻 agent 调用 → Candidate
  const explicitTargets = new Set(edges.filter((e) => e.confidence === "Explicit").map((e) => e.to))
  const agents = nodes.filter((n) => n.kind === "agent" || n.kind === "workflow")
  for (let i = 0; i < agents.length; i++) {
    const prev = agents[i - 1]
    const cur = agents[i]!
    if (!prev) continue
    if (cur.references.length > 0 || prev.dynamic || cur.dynamic) continue
    if (cur.containerId && cur.containerId === prev.containerId) continue
    if (explicitTargets.has(cur.id)) continue
    edges.push({
      from: prev.id,
      to: cur.id,
      confidence: "Candidate",
      reason: "源码顺序相邻但无数据引用（可能独立，需语义确认；不可自动并行化）",
    })
  }

  return { nodes, edges, unknowns, diagnostics }
}
