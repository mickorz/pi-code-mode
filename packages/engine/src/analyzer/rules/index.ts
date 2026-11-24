/**
 * 内置规则集（M1-T3）
 *
 * 规则 ID 命名：<领域>-<序号>
 *  CONC  并发/波次   INPUT 输入规模与重复注入   SERIAL 串行/并行候选
 *  TIMEOUT 超时      RETRY 重试成本            DET 确定性可代码化    REC 恢复能力
 *
 * 原则（陷阱 2）：静态结论必须带 confidence；Candidate/Unknown 不得升级为确定缺陷。
 */
import type { AnalyzerContext, AnalyzerFinding, AnalyzerRule } from "../types.js"

/**
 * 估算任务量：静态可定循环上界按上界计，否则按 1（下限）
 * M6：REC-001/CONC-001 必须用「估算任务数」而不是「调用点数」，
 * 否则 `for (i<25) agent()` 这种单调用点 25 次执行会被当成 1 个任务
 */
function estimateTaskCount(ctx: AnalyzerContext): { total: number; determined: boolean } {
  let total = 0
  let determined = true
  for (const n of ctx.ast.nodes) {
    if (n.kind !== "agent" && n.kind !== "workflow") continue
    const max = n.loopBounds?.max
    if (max !== undefined) total += max
    else if (!n.dynamic) total += 1
    else {
      determined = false
      total += 1
    }
  }
  return { total, determined }
}

/** 从源码静态提取 setConcurrency(n) 与 agent 数 */
function staticsOf(ctx: AnalyzerContext) {
  const m = /setConcurrency\s*\(\s*(\d+)\s*\)/.exec(ctx.source)
  const concurrency = m ? Number(m[1]) : ctx.concurrency
  const agentCalls = ctx.graph.counts.agent ?? 0
  const workflows = ctx.graph.counts.workflow ?? 0
  return { concurrency, agentCalls, workflows, total: agentCalls + workflows }
}

/**
 * CONC-002：并行任务数在运行时才确定（动态分片）
 *
 * 真实场景（PrdGameSkill S4/S5）：`parallel(partFiles.map(...))` —— partFiles 运行时从 manifest 读，
 * 静态无法知道分片数。这类结构恰恰是最主要的墙钟来源（40 分片 × 单次 10-30 分钟 / 并发上限 = 多波次 + 长尾），
 * 但 CONC-001 因「任务数不可知」不报，用户就会以为"没风险"。
 *
 * 这里不是断言缺陷（confidence 低），而是提示必须人工确认的三个量：
 * 分片数 / 并发上限 / 单次超时。
 */
export const dynamicParallel: AnalyzerRule = {
  id: "CONC-002",
  version: "1.0",
  severity: "medium",
  description: "并行任务数是运行时动态决定的分片（静态不可知，需人工确认分片数/并发/超时）",
  analyze(ctx) {
    const findings: AnalyzerFinding[] = []
    // 并行调用的第一个参数是 X.map(...) / X.filter(...).map(...) 这类运行时集合表达式
    const re = /(parallel|pipeline)\s*\(\s*([A-Za-z_$][\w$.]*)\s*\.\s*(map|flatMap)\s*\(/g
    const seen = new Set<number>()
    let m: RegExpExecArray | null
    while ((m = re.exec(ctx.source)) !== null) {
      const collection = m[2]!
      if (seen.has(m.index)) continue
      seen.add(m.index)
      // 若该集合能静态定长度（字面量数组 / new Array(N)），交给 CONC-001 估波次，这里不再重复提示
      const escaped = collection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const staticallySized = new RegExp(
        `(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:\\[|new\\s+Array\\s*\\(\\s*\\d+\\s*\\))`,
      ).test(ctx.source)
      if (staticallySized) continue
      const line = ctx.source.slice(0, m.index).split("\n").length
      const { concurrency } = staticsOf(ctx)
      const timeoutMatch = /timeoutMs\s*:\s*(\d+)/g
      const timeouts: number[] = []
      let t: RegExpExecArray | null
      while ((t = timeoutMatch.exec(ctx.source)) !== null) timeouts.push(Number(t[1]))
      const maxTimeout = timeouts.length > 0 ? Math.max(...timeouts) : undefined

      findings.push({
        ruleId: "CONC-002",
        severity: "medium",
        // 静态无法知道分片数 → 这是「需要人工确认」的提示，不是缺陷判定
        confidence: 0.4,
        location: { startLine: line, endLine: line },
        evidence: [
          `并行任务数来自运行时集合 \`${collection}\`（${m[3]}），静态不可知`,
          `并发上限：${concurrency ?? "未声明（运行时默认 CPU-2，上限 16）"}`,
          maxTimeout !== undefined ? `单次超时：${Math.round(maxTimeout / 1000)}s` : "未发现 timeoutMs",
        ],
        suggestion:
          "确认三件事：①分片数（决定波次数）②并发上限是否匹配（setConcurrency 或 run 参数）③单次超时是否够。分片多 + 单次长会造成多波次长尾，是墙钟主要来源",
      })
    }
    return findings
  },
}

/** CONC-001：并行波次估算（任务数 > 并发上限） */
export const concWaves: AnalyzerRule = {
  id: "CONC-001",
  version: "1.0",
  severity: "medium",
  description: "并行任务数超过并发上限 → 多波次执行（要求任务数静态可确定）",
  analyze(ctx) {
    const { concurrency, total } = staticsOf(ctx)
    const parallelNodes = ctx.ast.nodes.filter((n) => n.kind === "parallel" || n.kind === "pipeline")
    if (parallelNodes.length === 0) return []
    const findings: AnalyzerFinding[] = []
    // 静态可确定的并行任务数：parallel 内部的 agent 调用点 × 可确定循环上界
    let estTasks = 0
    let determined = true
    for (const node of ctx.ast.nodes.filter((n) => n.containerId && (n.kind === "agent" || n.kind === "workflow"))) {
      const bound = node.loopBounds?.max
      if (bound !== undefined) estTasks += bound
      else if (!node.dynamic) estTasks += 1
      else determined = false
    }
    if (estTasks === 0) return []
    const cap = concurrency ?? 16
    if (estTasks > cap) {
      const waves = Math.ceil(estTasks / cap)
      findings.push({
        ruleId: "CONC-001",
        severity: "medium",
        confidence: determined ? 0.9 : 0.5,
        location: { startLine: parallelNodes[0]!.startLine, endLine: parallelNodes[0]!.endLine },
        evidence: [
          `并行调用点约 ${estTasks} 个${determined ? "" : "（含动态节点，估算下限）"}`,
          `并发上限 ${cap}`,
          `预计 ${waves} 个波次`,
        ],
        suggestion: "评估分片合并或减少任务数；波次越多，长尾 Agent 对墙钟影响越显著",
      })
    }
    return findings
  },
}

/** INPUT-001：重复上下文注入（同一大对象被多次传递） */
export const inputRepeat: AnalyzerRule = {
  id: "INPUT-001",
  version: "1.0",
  severity: "high",
  description: "同一个输入对象被多次注入不同 agent → 重复序列化与 token 浪费",
  analyze(ctx) {
    const findings: AnalyzerFinding[] = []
    // 统计每个标识符在多少个 agent/workflow 调用参数中出现（含动态模板引用）
    const usage = new Map<string, number[]>()
    for (const n of ctx.ast.nodes) {
      if (n.kind !== "agent" && n.kind !== "workflow") continue
      for (const id of n.referencedIdentifiers) {
        if (id.length < 3) continue
        usage.set(id, [...(usage.get(id) ?? []), n.startLine])
      }
    }
    for (const [ident, lines] of usage) {
      if (lines.length < 2) continue
      // 体积判定（PrdGameSkill 真实场景验收发现：仅按「出现≥2 次」会把 join/label/filePath/def 等普通标识符误报）
      // 仅当满足之一才视为「重复注入大对象」：
      //   1) 以 JSON.stringify 整体注入
      //   2) 声明处为大数组/大对象字面量（≥200 字符）
      //   3) 变量名为整体性语义名（requirements/rules/context/evidence 等，按整词匹配）
      const serialized = new RegExp(`JSON\\.stringify\\s*\\(\\s*${ident}\\b`).test(ctx.source)
      const bulkyDecl = new RegExp(
        `(?:const|let|var)\\s+${ident}\\s*=\\s*\\[[^\\]]{200,}|(?:const|let|var)\\s+${ident}\\s*=\\s*\\{[^}]{200,}`,
        "s",
      ).test(ctx.source)
      const semanticHint =
        /^(all|full)?(requirements?|rules|prd|context|documents?|contents?|specs?|evidences?|items)$/i.test(ident) ||
        /^(all|full|)(Requirements|Rules|Prd|Context|Document|Contents|Specs|Evidence|Items)(Text|All|Full|List)?$/.test(ident) ||
        /(Requirements|Rules|Prd|Context|Documents|Contents|Specs|Evidence|Items)(Text|All|Full|List)$/.test(ident)
      if (!serialized && !bulkyDecl && !semanticHint) continue
      findings.push({
        ruleId: "INPUT-001",
        severity: serialized && lines.length >= 3 ? "high" : "medium",
        confidence: serialized ? 0.85 : 0.6,
        location: { startLine: Math.min(...lines), endLine: Math.max(...lines) },
        evidence: [
          `标识符 \`${ident}\` 在 ${lines.length} 个 agent/workflow 调用中出现（行 ${lines.join(", ")}）`,
          ...(serialized ? [`并以 JSON.stringify 方式整体注入（序列化开销 × ${lines.length}）`] : []),
        ],
        suggestion:
          "提取为 Shared Context 公共引用（M4 三层上下文），保留 Evidence Reference 层的原始来源；不要压缩成摘要代替原文",
      })
    }
    return findings
  },
}

/** SERIAL-001：串行链（仅提示，不判定为缺陷） */
export const serialChain: AnalyzerRule = {
  id: "SERIAL-001",
  version: "1.0",
  severity: "low",
  description: "多个 agent 构成明确数据依赖链（合理串行，但可能是墙钟瓶颈）",
  analyze(ctx) {
    return ctx.deps.serialChains
      .filter((c) => c.length >= 3)
      .map((chain) => {
        const first = ctx.ast.nodes.find((n) => n.id === chain[0])
        const last = ctx.ast.nodes.find((n) => n.id === chain.at(-1))
        return {
          ruleId: "SERIAL-001",
          severity: "low" as const,
          confidence: 0.95,
          location: { startLine: first?.startLine ?? 0, endLine: last?.endLine ?? 0 },
          evidence: [`${chain.length} 个调用构成 Explicit 数据依赖链（${chain.join(" → ")}）`],
          suggestion: "存在明确数据依赖，属合理串行；如需提速应缩短单次耗时或拆分任务粒度，而非并行化",
        }
      })
  },
}

/** SERIAL-002：并行候选（Candidate 置信度，需语义确认） */
export const parallelCandidate: AnalyzerRule = {
  id: "SERIAL-002",
  version: "1.0",
  severity: "medium",
  description: "源码相邻但无数据引用的 agent 调用 → 可并行候选（需语义确认）",
  analyze(ctx) {
    return ctx.deps.candidates.map((c) => ({
      ruleId: "SERIAL-002",
      severity: "medium" as const,
      // 有 risk 的候选置信度下调（组内含动态/Explicit 节点）
      confidence: c.risk ? 0.4 : 0.7,
      location: { startLine: Math.min(...c.lines), endLine: Math.max(...c.lines) },
      evidence: [
        `${c.ids.length} 个调用源码相邻但无数据引用（${c.ids.join(", ")}）`,
        ...(c.risk ? [c.risk] : []),
      ],
      suggestion: "经语义确认业务独立后可改为 parallel；静态 Candidate 不构成自动并行化依据",
    }))
  },
}

/** TIMEOUT-001：agent 缺超时兜底 */
export const timeoutMissing: AnalyzerRule = {
  id: "TIMEOUT-001",
  version: "1.0",
  severity: "medium",
  description: "agent 调用缺少 timeoutMs 且无 run 级超时 → 单点挂起会拖垮整阶段",
  analyze(ctx) {
    const findings: AnalyzerFinding[] = []
    // 粗粒度：统计 agent( 调用与 timeoutMs 出现次数
    const agentCount = (ctx.source.match(/\bagent\s*\(/g) ?? []).length
    const timeoutCount = (ctx.source.match(/timeoutMs\s*:/g) ?? []).length
    const runTimeout = /agentTimeoutMs|timeoutMs\s*:/.test(ctx.source)
    if (agentCount > 0 && timeoutCount === 0 && !runTimeout) {
      const first = ctx.ast.nodes.find((n) => n.kind === "agent")
      findings.push({
        ruleId: "TIMEOUT-001",
        severity: "medium",
        confidence: 0.75,
        location: { startLine: first?.startLine ?? 1, endLine: first?.endLine ?? 1 },
        evidence: [`${agentCount} 个 agent 调用均未声明 timeoutMs，且无 run 级超时`],
        suggestion: "长耗任务显式声明 timeoutMs（参考 workflow-authoring 默认 3600000），避免单点挂起拖垮整阶段",
      })
    }
    return findings
  },
}

/** RETRY-001：重试成本放大（retries 配置 × agent 数） */
export const retryCost: AnalyzerRule = {
  id: "RETRY-001",
  version: "1.0",
  severity: "low",
  description: "retries 放大失败场景下的调用量与 token 消耗",
  analyze(ctx) {
    // location 必须指向**实际 retries>=2 的那一行**，不能沿用「首个 agent 调用」。
    // 实测：1-scan-template.js 的 retries: 2 在 L184，但首个 agent 在 L101，
    // 导致 optimize 的片段窗口（L61-160）完全没覆盖到要改的代码，AI 只能拒绝生成补丁。
    const all = [...ctx.source.matchAll(/retries\s*:\s*(\d+)/g)].map((m) => ({ value: Number(m[1]), index: m.index ?? 0 }))
    if (all.length === 0) return []
    const hits = all.filter((x) => x.value >= 2)
    if (hits.length === 0) return []
    const max = Math.max(...hits.map((h) => h.value))
    const lineOfIndex = (idx: number): number => {
      let line = 1
      for (let i = 0; i < idx && i < ctx.source.length; i++) if (ctx.source[i] === "\n") line++
      return line
    }
    const lines = hits.map((h) => lineOfIndex(h.index))
    const startLine = Math.min(...lines)
    const endLine = Math.max(...lines)
    const agentCalls = ctx.graph.counts.agent ?? 0
    return [
      {
        ruleId: "RETRY-001",
        severity: "low" as const,
        confidence: 0.8,
        location: { startLine, endLine },
        evidence: [
          `retries 最高 ${max} 次（${hits.length} 处 ≥2，行 ${lines.slice(0, 8).join(", ")}${lines.length > 8 ? " …" : ""}）`,
          `agent 调用点 ${agentCalls} 个`,
          `失败场景最坏调用量 ≈ ${agentCalls * (max + 1)}`,
        ],
        suggestion: "全量失败时重试会造成成倍 token 消耗，配合 M3 任务级恢复只重跑失败任务",
      },
    ]
  },
}

/** DET-001：确定性操作可代码化（LLM 处理本可确定性完成的统计/过滤） */
export const deterministicCandidate: AnalyzerRule = {
  id: "DET-001",
  version: "1.0",
  severity: "low",
  description: "prompt 语义看起来可用确定性 JS 完成（统计/校验），交给 LLM 是浪费",
  analyze(ctx) {
    const patterns: Array<{ re: RegExp; hint: string }> = [
      { re: /agent\s*\(\s*[`'"][^`'"]*(统计|计数|去重|排序|编号|汇总数量)/, hint: "统计/计数/去重/排序类任务优先用 JS 确定性完成" },
      { re: /agent\s*\(\s*[`'"][^`'"]*(校验|核对格式|字段是否齐全)/, hint: "结构化字段校验可用 JS 完成" },
    ]
    const findings: AnalyzerFinding[] = []
    // 与 IO-001 互斥：回读器/转写器的 prompt 里出现"统计"是名词（"注册表统计回读器"），
    // 不是"统计任务"。这类由 IO-001 负责，DET-001 不能再报（否则同一调用两个 finding）。
    const IO_PROMPT_RE = /只做读取与转写|只做读取|回读器|读取器|逐字写入|逐字复制|read\s*工具读取|write\s*工具写入/
    for (const { re, hint } of patterns) {
      const node = ctx.ast.nodes.find(
        (n) => n.kind === "agent" && n.promptPreview && !IO_PROMPT_RE.test(n.promptPreview) && re.test(`agent(\`${n.promptPreview}`),
      )
      if (node) {
        findings.push({
          ruleId: "DET-001",
          severity: "low",
          confidence: 0.5,
          location: { startLine: node.startLine, endLine: node.endLine },
          evidence: [`prompt 语义疑似确定性任务：${node.promptPreview}`],
          suggestion: hint,
        })
      }
    }
    return findings
  },
}

/** REC-001：大规模并行 + 无阶段边界（失败恢复成本高） */
export const recoveryRisk: AnalyzerRule = {
  id: "REC-001",
  version: "1.0",
  severity: "high",
  description: "大规模任务且无 phase 边界 → 失败后只能整 run 重跑",
  analyze(ctx) {
    const { total, determined } = estimateTaskCount(ctx)
    const phases = (ctx.source.match(/\bphase\s*\(/g) ?? []).length
    if (total >= 20 && phases === 0) {
      const first = ctx.ast.nodes[0]
      return [
        {
          ruleId: "REC-001",
          severity: "high" as const,
          confidence: determined ? 0.8 : 0.5,
          location: { startLine: first?.startLine ?? 1, endLine: first?.endLine ?? 1 },
          evidence: [
            `估算任务量 ${total}${determined ? "" : "（下限，含动态节点）"}（≥20）且无 phase 阶段边界`,
            "无阶段边界时失败后只能整 run 重跑或依赖 journal 前缀回放",
          ],
          suggestion: "用 phase() 划分阶段边界，配合 M3 TaskCheckpoint 实现任务级恢复（只重跑失败任务）",
        },
      ]
    }
    return []
  },
}

/** 内置规则集（顺序即报告顺序） */
/**
 * REC-002：恢复模式读取的收窄集合没有沿调用链传入
 *
 * aiOnly：需要追踪变量在函数参数/对象属性间的流动（impact.impactSet → runStage 参数），
 * 单文件局部 AST 无法可靠判定。强行写正则近似会误报（同名参数语义可能不同）。
 * 判定完全交给 AI Rule Check（依据 definitions/10-REC-002-rule.md）。
 */
export const recoveryNarrowing: AnalyzerRule = {
  id: "REC-002",
  version: "1.0",
  severity: "high",
  description: "恢复模式（retry/resume/from-stage）读取的收窄集合没有沿调用链传给下游 workflow → 恢复退化为全量重跑",
  aiOnly: true,
  analyze() {
    // 静态不判定：见 aiOnly 注释。返回空数组，报告里状态显示「静态不判定（由 AI 检查）」
    return []
  },
}


/** IO-001：确定性文件 IO 交给 agent（readBack / echoWrite 模式） */
export const deterministicIo: AnalyzerRule = {
  id: "IO-001",
  version: "1.0",
  severity: "medium",
  description: "agent prompt 要求用 read/write 工具处理文件 → 确定性 IO 走了模型往返",
  analyze(ctx) {
    // prompt 里出现这些指令说明本质是确定性文件读写，交给模型纯属浪费且有改写风险
    const PATTERNS: Array<{ re: RegExp; hint: string }> = [
      { re: /(?:使用|用)\s*(?:read|write)\s*工具/, hint: "读写工具指令" },
      { re: /read\s*工具读取|write\s*工具写入/, hint: "读写工具指令" },
      { re: /只做读取与转写|只做读取/, hint: "回读器自述" },
      { re: /逐字写入文件|逐字复制|逐字转写/, hint: "写盘器自述" },
      { re: /原样返回[^。]{0,20}文件|原样返回其中字段/, hint: "原样回读" },
    ]
    const hits: Array<{ line: number; hint: string; preview: string }> = []
    for (const node of ctx.ast.nodes) {
      if (node.kind !== "agent") continue
      const preview = node.promptPreview ?? ""
      if (!preview) continue
      for (const { re, hint } of PATTERNS) {
        if (re.test(preview)) {
          hits.push({ line: node.startLine, hint, preview: preview.slice(0, 60) })
          break
        }
      }
    }
    if (hits.length === 0) return []
    return [
      {
        ruleId: "IO-001",
        severity: hits.length >= 3 ? ("medium" as const) : ("low" as const),
        confidence: 0.8,
        location: { startLine: Math.min(...hits.map((h) => h.line)), endLine: Math.max(...hits.map((h) => h.line)) },
        evidence: [
          `${hits.length} 处 agent 调用把确定性文件 IO 交给模型（行 ${hits.map((h) => h.line).join(", ")}）`,
          `首处：${hits[0]!.hint} —— ${hits[0]!.preview}`,
        ],
        suggestion:
          "优先改用受治理的 readFile/writeFileAtomic（带路径白名单、原子写、hash 校验）；无法迁移时至少给写盘加写后回读 hash 校验",
      },
    ]
  },
}

/** INPUT-002：阶段输入校验范围超出目标阶段 */
export const inputScopeMismatch: AnalyzerRule = {
  id: "INPUT-002",
  version: "1.0",
  severity: "medium",
  description: "阶段起点分支要求了该阶段并不需要的输入 → 阶段级恢复被无关输入阻断",
  analyze(ctx) {
    const src = ctx.source
    // 只识别 effectiveStartIdx <= N 这类字面量分支
    const branchRe = /if\s*\(\s*(?:effectiveStartIdx|startIdx)\s*<=\s*(\d+)\s*\)\s*\{/g
    const checkRe = /check\s*\(\s*\(\)\s*=>\s*fileExists\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g
    const findings: AnalyzerFinding[] = []
    const seen = new Set<string>()

    for (const m of src.matchAll(branchRe)) {
      const limit = Number(m[1])
      // 取该 if 块区间（简单花括号配对）
      const startIdx = m.index ?? 0
      const openBrace = src.indexOf("{", startIdx)
      let depth = 0
      let end = openBrace
      for (let i = openBrace; i < src.length; i++) {
        if (src[i] === "{") depth++
        else if (src[i] === "}") {
          depth--
          if (depth === 0) {
            end = i
            break
          }
        }
      }
      const block = src.slice(openBrace, end)
      for (const c of block.matchAll(checkRe)) {
        const pathVar = c[1]!
        const key = `${pathVar}@${limit}`
        if (seen.has(key)) continue
        // 该变量在其他地方的首次使用行：若都出现在更大的起始索引块里，说明当前分支过度要求
        const otherUse = new RegExp(`\b${pathVar}\b`, "g")
        const uses = [...src.matchAll(otherUse)].map((u) => u.index ?? 0).filter((i) => i < openBrace || i > end)
        // 语义对立命名（client vs server）是最强信号
        const isClientInput = /^(codeDir|fguiDir|clientCodeDir|clientDir)$/i.test(pathVar)
        const isServerInput = /^(serverSrcRoot|serverDir|serverCodeDir)$/i.test(pathVar)
        // S4 需要 client 输入（起点 <= 3）；S5 需要 server 输入（起点 <= 4）
        if (isClientInput && limit > 3) {
          seen.add(key)
          findings.push({
            ruleId: "INPUT-002",
            severity: "medium",
            confidence: 0.85,
            location: { startLine: lineOf(src, openBrace), endLine: lineOf(src, end) },
            evidence: [
              `起点 <= ${limit} 的分支要求客户端输入 \`${pathVar}\`（该输入只在 S4 需要）`,
              `受影响：from-stage startStage=S5 / retryScope=server 会被无关客户端目录阻断`,
            ],
            suggestion: "把客户端输入校验收窄到 effectiveStartIdx <= 3；服务端输入放在 <= 4 的独立分支",
          })
        }
        if (isServerInput && limit > 4) {
          seen.add(key)
          findings.push({
            ruleId: "INPUT-002",
            severity: "medium",
            confidence: 0.85,
            location: { startLine: lineOf(src, openBrace), endLine: lineOf(src, end) },
            evidence: [
              `起点 <= ${limit} 的分支要求服务端输入 \`${pathVar}\`（该输入只在 S5 需要）`,
              `受影响：from-stage startStage=S6+ 会被无关服务端目录阻断`,
            ],
            suggestion: "服务端输入校验收窄到 effectiveStartIdx <= 4",
          })
        }
        void uses
      }
    }
    return findings
  },
}

/** 源码偏移 → 行号 */
function lineOf(src: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === "\n") line++
  return line
}

/**
 * BUDGET-001：嵌套 workflow 并发预算未显式切分
 * aiOnly：需要入口 + 子流程的嵌套并发结构，单文件 AST 不够。
 */
export const nestedBudget: AnalyzerRule = {
  id: "BUDGET-001",
  version: "1.0",
  severity: "high",
  description: "入口并行调度子 workflow，子流程内部又动态并行，但并发预算未显式切分 → 实际在途数可能翻倍",
  aiOnly: true,
  analyze() {
    return []
  },
}

/**
 * SIDEFX-001：并行候选共享文件/状态副作用
 * aiOnly：需要判断两次调用的写/读路径是否重合或存在写后读。
 */
export const parallelSideEffects: AnalyzerRule = {
  id: "SIDEFX-001",
  version: "1.0",
  severity: "high",
  description: "SERIAL-002 报出的并行候选实际通过文件路径或共享状态存在隐式依赖 → 不能并行化",
  aiOnly: true,
  analyze() {
    return []
  },
}

export const BUILTIN_RULES: AnalyzerRule[] = [
  inputRepeat,
  concWaves,
  dynamicParallel,
  serialChain,
  parallelCandidate,
  timeoutMissing,
  retryCost,
  deterministicCandidate,
  recoveryRisk,
  recoveryNarrowing,
  deterministicIo,
  inputScopeMismatch,
  nestedBudget,
  parallelSideEffects,
]
