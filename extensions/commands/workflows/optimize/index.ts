/**
 * /workflows optimize 子命令（O0 + O1）
 *
 * 用户命令面只有 3 条（见 2026-11-20-workflow-optimization-command-simplification.md）：
 *   optimize <file-or-dir> [--rules R,R] [--tier T] [--fresh]   生成并验证候选（不改原文件）
 *   optimize apply <id>                                          写回（备份 + hash 校验 + 原子写 + 重分析）
 *   optimize rollback <id> [--force]                             从会话备份恢复
 *
 * status / review / benchmark / discard 是内部生命周期，不暴露为命令。
 */
import fs from "node:fs"
import path from "node:path"

import { analyzeWorkflow, createPlannerAgent, resolveTierModel } from "../../../../src/tools/workflow-analyze-tool.js"
import { loadRuleDocs } from "../../../../src/engine/analyzer/ai-rule-checker/rule-doc-loader.js"
import { condenseRuleDoc } from "../../../../src/engine/analyzer/ai-rule-checker/prompt-builder.js"
import {
  buildDashboardView,
  renderDashboardHtml,
  writeDashboard,
  type DashboardView,
} from "../../../../src/engine/analyzer/dashboard/build-dashboard.js"
import type { AnalysisReport } from "../../../../src/engine/analyzer/report-builder.js"
import { generatePatchSet } from "../../../../src/engine/optimizer/patch-generator.js"
import { reviewPatch } from "../../../../src/engine/optimizer/patch-reviewer.js"
import { applyPatchSet, validatePatchSet } from "../../../../src/engine/optimizer/patch-validator.js"
import { renderReview } from "../../../../src/engine/optimizer/review-renderer.js"
import { renderBenchmarkVerdict, runRealBenchmark, type RealRunOutcome } from "../../../../src/engine/optimizer/benchmark-adapter.js"
import { applyToProduction, readBackupManifest, rollbackFromBackup } from "../../../../src/engine/optimizer/apply-service.js"
import { renderVerifier, runVerifierCommand, type VerifierResult } from "../../../../src/engine/optimizer/verifier-runner.js"
import { makeWorkflowTool } from "../../../../src/tools/workflow-tools.js"
import { openInBrowser, shouldAutoOpen } from "../../../../src/utils/open-browser.js"
import {
  findOpenSession,
  nextSessionId,
  readSession,
  sessionPaths,
  toRelKey,
  updateSession,
  writeSession,
} from "../../../../src/engine/optimizer/session-store.js"
import type { OptimizationSession, PatchReview, PatchSet } from "../../../../src/engine/optimizer/session-types.js"
import { resolveTarget, sha256 as sha256Of } from "../../../../src/engine/optimizer/target-resolver.js"
import { copyWorkspace, detectSourceChanges } from "../../../../src/engine/optimizer/workspace.js"
import type { Subcommand } from "../types.js"

/** 默认可自动优化（副作用小、验证可穷尽）；其余规则只诊断不自动改 */
/**
 * 默认可自动优化（副作用小 / 改动局部性 / 可验证）：
 *  - RETRY-001：改字面量（如 2→1），不碰调用结构与返回语义，有验证器可对比产物
 *  - DET-001 / IO-001：把确定性 IO/统计改成 JS（需运行时支持，模型会自己判定可行性）
 *  - REC-002：修参数传递链路
 * 注：RETRY-001 曾经两边都不在，导致不给 --rules 时永远选不到它（用户实测报
 * 「没有可安全自动优化的问题簇」，但它恰恰是最安全的一类）。
 */
const AUTO_SAFE_RULES = new Set(["RETRY-001", "DET-001", "IO-001", "REC-002"])
/** 明确不自动改：需要运行语义或副作用证明 */
const AUTO_UNSAFE_RULES = new Set(["SERIAL-002", "CONC-002", "SIDEFX-001", "BUDGET-001"])
/**
 * 这些规则是 aiOnly：静态层不产出 finding，因此 `report.clusters` 里**永远没有它们**。
 * 必须靠 AI Rule Check 的结论来构造候选（否则 --rules REC-002 会判「无可自动优化项」）。
 */
const AI_ONLY_SAFE_RULES = new Set(["REC-002"])
/**
 * 档位分工（CLAUDE.md 已确认，2026-11-20 用户决策）：
 *  - 分析类（AI Rule Check）用 big：强模型看代码，允许 ≤10 分钟
 *  - 执行类（生成补丁 / 审查 diff）用 fast：要快，迭代成本低
 *
 * 实测依据：big 档生成含完整上下文的补丁会 >240s（3 次均超时），
 * 而 fast 档 14~60s 即可给出可用的最小补丁。
 */
const ANALYZER_TIER = "big"
const GENERATOR_TIER = "fast"
const REVIEWER_TIER = "fast"

export const optimizeSubcommand: Subcommand = {
  usage:
    "optimize <路径|目录> [--rules R,R] [--tier T] [--fresh] | optimize apply <id> | optimize rollback <id>  生成并验证 Workflow JS 优化候选（不改原文件）",
  async run(argv, ctx, deps) {
    try {
      const [first, ...rest] = argv
      if (!first) {
        ctx.ui.notify(usageText(), "info")
        return
      }
      if (first === "apply") {
        await runApply(rest, ctx, deps)
        return
      }
      if (first === "rollback") {
        await runRollback(rest, ctx, deps)
        return
      }
      await runOptimize(first, rest, ctx, deps)
    } catch (e) {
      ctx.ui.notify(`优化失败：${String((e as Error)?.stack ?? e).slice(0, 800)}`, "warning")
    }
  },
}

function usageText(): string {
  return [
    "用法：",
    "  /workflows optimize <路径|目录> [--rules R,R] [--tier T] [--fresh]",
    "      分析并生成优化候选（隔离工作区验证，不修改原文件）",
    "  /workflows optimize apply <优化编号>",
    "      将已验证候选写回原文件（先备份，再原子写入）",
    "  /workflows optimize rollback <优化编号>",
    "      从该候选的备份恢复原文件",
    "",
    `默认可自动优化：${[...AUTO_SAFE_RULES].join(", ")}`,
    `默认不自动改：${[...AUTO_UNSAFE_RULES].join(", ")}（需人工判断副作用/运行语义）`,
  ].join("\n")
}

/**
 * 取 flag 的值。
 *
 * 两条容错（实测都得有）：
 *  1. **pi 的命令行不是 shell**——`args.trim().split(/\s+/)` 不做引号解析，
 *     用户按 shell 习惯写的 `--args '{"a":1}'` 会把单引号原样传进来，
 *     JSON.parse 直接报 `Unexpected token '''`。这里剥掉首尾配对引号。
 *  2. JSON 里带空格（如 `{"a": 1}`）会被 split 拆成多个 token，所以要拼到下一个 `--` 前。
 */
function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  const parts: string[] = []
  for (let j = i + 1; j < argv.length; j++) {
    if (argv[j]!.startsWith("--")) break
    parts.push(argv[j]!)
  }
  if (parts.length === 0) return undefined
  let v = parts.join(" ")
  // 剥掉整串首尾配对的引号（单/双）
  const first = v[0]
  if ((first === "'" || first === '"') && v.length > 1 && v.endsWith(first)) {
    v = v.slice(1, -1)
  }
  return v
}

// ---------------------------------------------------------------- optimize

async function runOptimize(ref: string, argv: string[], ctx: any, deps: any): Promise<void> {
  /**
   * 后台化（2026-11-23）：与 /workflows run 保持一致。
   *
   * 之前是整个方法体同步 await —— 1~3 分钟 AI 复核期间 TUI 卡死、无法取消，
   * ctrl+b 也看不到东西（optimize 不是 RunManager 的 run，没有节点快照）。
   *
   * 现在：register 一个 run 后立刻返回，主体逻辑在后台跑，
   * 阶段进度 emit 给 RunManager（widget / status 可见），完成后 deliver 回传。
   */
  const cwd0 = ctx.cwd ?? process.cwd()
  const isBenchmarkOnly = argv.includes("--benchmark") && !argv.includes("--fresh")

  let runId = ""
  let run: any
  try {
    const probe = findOpenSession(cwd0, ref)
    if (isBenchmarkOnly && probe) {
      runId = `opt-bench-${probe.id}`
    } else {
      runId = `opt-run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    }
    run = deps.runManager.register(runId, { label: `optimize:${ref}` })
  } catch {
    // RunManager 不可用（如测试 fake）：退化为前台执行
    await runOptimizeBody(ref, argv, ctx, deps, undefined)
    return
  }

  // 阶段进度上报：notify 给用户看，attach 给 status/widget 看。
  // 每个阶段独立节点，开始下一个时把上一个置 ok —— 否则 status 里永远显示最后一项 running。
  let lastStageNo = 0
  const emitStage = (n: number, msg: string) => {
    try {
      if (lastStageNo > 0 && lastStageNo !== n) {
        deps.runManager.attach(runId, {
          id: `${runId}:stage-${lastStageNo}`,
          label: `[${lastStageNo}/6]`,
          status: "ok",
          startedAt: Date.now(),
          durationMs: 0,
        } as any)
      }
      lastStageNo = n
      deps.runManager.attach(runId, {
        id: `${runId}:stage-${n}`,
        label: msg.slice(0, 80),
        status: "running",
        startedAt: Date.now(),
      } as any)
    } catch {
      /* 快照失败不影响主流程 */
    }
  }
  const sealStage = () => {
    if (lastStageNo === 0) return
    try {
      deps.runManager.attach(runId, {
        id: `${runId}:stage-${lastStageNo}`,
        label: `[${lastStageNo}/6]`,
        status: "ok",
        startedAt: Date.now(),
        durationMs: 0,
      } as any)
    } catch {
      /* ignore */
    }
  }
  const stageEmit = (msg: string, n?: number) => emitStage(n ?? lastStageNo + 1, msg)
  void sealStage

  const bgNotice = [
    `optimize 已转入后台：runId=${runId}`,
    `实时进度：/workflows watch ${runId}`,
    `查询：/workflows status ${runId} ｜ 停止：/workflows cancel ${runId}`,
    "",
    "完成后结果会自动回传本会话。",
  ].join("\n")
  ctx.ui.notify(bgNotice, "info")
  // 非 TUI 模式（pi -p / headless / CI）下 ctx.ui.notify 不输出到 stdout，
  // 实测 pi -p 跑 optimize 时除了档位告警外一片空白，用户以为没执行。
  // 此时补一条 deliver（走会话消息流，print 模式可见）。
  if (ctx.hasUI !== true) {
    void deps.deliver?.(bgNotice)
  }

  // 后台执行（不阻塞命令返回）
  void (async () => {
    try {
      const summary = await runOptimizeBody(ref, argv, ctx, deps, { runId, stageEmit, sealStage })
      deps.runManager.finish(runId, { status: "completed", resultPreview: (summary ?? "optimize 完成").slice(0, 200) })
      // 成功也要回传：命令已提前返回，用户否则看不到结果
      await deps.deliver?.(`[optimize 完成] runId=${runId}\n${(summary ?? "详见会话 review.md").slice(0, 1200)}`)
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      const cancelled = run?.controller?.signal?.aborted
      deps.runManager.finish(runId, { status: cancelled ? "cancelled" : "failed", error: msg })
      await deps.deliver?.(
        `[optimize ${cancelled ? "已停止" : "失败"}] runId=${runId}\n${msg.slice(0, 600)}\n\n已生成的候选仍在 .pi/workflows/optimizations/ 下。`,
      )
    }
  })()
}

/**
 * optimize 的实际主体（原 runOptimize 内容）。
 * @param runtime 后台模式下携带 runId 与阶段回调；前台模式为 undefined
 */
async function runOptimizeBody(
  ref: string,
  argv: string[],
  ctx: any,
  deps: any,
  runtime: { runId: string; stageEmit: (msg: string, n?: number) => void; sealStage: () => void } | undefined,
): Promise<string | undefined> {

  /** 后台模式下不碰 TUI；前台才 notify。所有中途提示统一走这里。 */
  const notify = (text: string, level: "info" | "warning" = "info"): string => {
    if (runtime) runtime.stageEmit(text)
    else ctx.ui.notify(text, level)
    return text
  }

  const cwd = ctx.cwd ?? process.cwd()
  const fresh = argv.includes("--fresh")
  const tier = flagValue(argv, "--tier") ?? GENERATOR_TIER
  const rulesArg = flagValue(argv, "--rules")
  const requested = rulesArg ? rulesArg.split(",").map((s) => s.trim()).filter(Boolean) : undefined
  // P2-8：usage 写着「明确不自动改」的规则，若用户显式 --rules 请求，必须再给 --unsafe-rules。
  // 否则「默认安全」形同虚设：一条 --rules SERIAL-002 就能把并行化建议推进自动改流程。
  if (requested) {
    const unsafeAsked = requested.filter((r) => AUTO_UNSAFE_RULES.has(r))
    if (unsafeAsked.length > 0 && !argv.includes("--unsafe-rules")) {
      return notify(
        [
          `[拒绝] 以下规则默认不自动改（需人工判断副作用/运行语义）：${unsafeAsked.join(", ")}`,
          "",
          "确认要尝试自动改，请显式加 --unsafe-rules：",
          `  /workflows optimize ${ref} --rules ${unsafeAsked.join(",")} --unsafe-rules`,
          "",
          "注意：并行化/并发预算类改动必须先用真实 Benchmark 证明产物一致，否则极易「快了但错了」。",
        ].join("\n"),
        "warning",
      )
    }
  }

  // 同 target 的未完成会话：
  //  - 带 --benchmark → 复用该会话跑真实验证（否则 benchmark 永远不可达、apply 到不了 ready）
  //  - 否则提示继续；--fresh 才新建
  if (!fresh) {
    const open = findOpenSession(cwd, ref)
    if (open) {
      const op = sessionPaths(cwd, open.id)
      if (argv.includes("--benchmark") && open.workspace.patchApplied) {
        notify(`复用候选 ${open.id}（状态 ${open.status}）跑真实 Benchmark…`, "info")
        const r = await benchmarkSession({
          sessionId: open.id,
          argv,
          ctx,
          deps,
          productionRoot: open.target.root,
          entryName: path.basename(open.target.ref),
          workspaceDir: open.workspace.path,
          sessionDir: op.dir,
        })
        if (!r) {
          return notify(`[验证未执行] ${open.id}：benchmarkSession 未返回结果（未知原因）`, "warning")
        }
        if (r.error) {
          return notify(`[验证未执行] ${open.id}\n${r.error}`, "warning")
        }
        const nextStatus = r.accepted ? "ready" : "rejected"
        updateSession(cwd, open.id, {
          status: nextStatus,
          validation: { benchmark: r.accepted ? "pass" : "fail", quality: r.quality },
          reason: r.accepted ? "真实 Benchmark 通过：可申请写回" : "真实 Benchmark 未通过，禁止 apply",
        })
        return notify(
          [
            r.accepted ? `[验证通过，可写回] ${open.id}` : `[验证未通过] ${open.id}`,
            "",
            r.text,
            "",
            r.accepted ? `写回：/workflows optimize apply ${open.id}` : `详情：${op.dir}/benchmark.md`,
          ].join("\n"),
          r.accepted ? "info" : "warning",
        )
      }
      // 按状态给出**具体**下一步，而不是一句泛泛的「继续处理」。
      // 否则用户反复重跑同一命令，只会被反复拦住，不知道该怎么办。
      const nextSteps: string[] = []
      if (open.status === "analyzed") {
        nextSteps.push(
          `该候选的结论：${open.reason ?? "已分析完成"}`,
          `结论详情（含模型给的分步方案）：${op.review} 第 2 节`,
          "",
          "换一个规则重试（会新建候选）：加 --fresh 并改 --rules，例如：",
          `  /workflows optimize ${ref} --rules RETRY-001 --fresh`,
        )
      } else if (open.workspace.patchApplied) {
        nextSteps.push(`跑真实验证：/workflows optimize ${ref} --benchmark --args '<json>' --verify-cmd '<cmd>'`)
      } else {
        nextSteps.push("继续处理该候选；如需重新生成请加 --fresh。")
      }
      return notify(
        [`发现该目标已有的优化候选：${open.id}（状态 ${open.status}）`, ...nextSteps].join("\n"),
        "info",
      )
    }
  }

  const resolved = resolveTarget(cwd, ref)
  if (typeof resolved === "string") {
    return notify(resolved, "warning")
  }

  /**
   * 阶段打点：optimize 是前台同步执行（不是后台 run），中间 1~3 分钟 AI 复核期间
   * 如果没有进度提示，用户会以为卡死，ctrl+b 也看不到任何东西（它不是 RunManager 的 run）。
   */
  const tStart = Date.now()
  const stage = (n: number, total: number, msg: string) => {
    const elapsed = ((Date.now() - tStart) / 1000).toFixed(0)
    const text = `[${n}/${total}] ${msg}（已 ${elapsed}s）`
    if (runtime) {
      // 后台模式：命令已返回，只在 RunManager 记进度（/workflows status|watch 可见）。
      // 不再直接调 ctx.ui.notify —— 命令返回后 ctx 可能已失效，或与 TUI 渲染循环冲突，
      // 是「跑完命令后整个会话输入无响应」的典型成因。
      runtime.stageEmit(text, n)
    } else {
      notify(text, "info")
    }
  }
  stage(1, 6, `静态分析 ${ref}（${resolved.files.length} 个 js）`)

  // ① 分析（静态 + AI Rule Check，默认开启；Planner 建议这里不需要，避免重复耗时）
  // 两段式：先纯静态拿问题簇（百毫秒），再只对选中规则做 big 档 AI 复核。
  // 全量 6 条语义规则在 big 档下单次 5~10 分钟，而 optimize 只关心选中的簇。
  const tStatic = Date.now()
  const statics = await analyzeWorkflow({
    ...(resolved.kind === "directory" ? { dirPath: resolved.root } : { scriptPath: path.join(resolved.root, path.basename(resolved.ref)) }),
    cwd,
    includeRuleCheck: false,
    includeSuggestions: false,
    format: "md",
  })
  if (!statics.ok || !statics.report) {
    return notify(`静态分析失败：${statics.error ?? "unknown"}`, "warning")
  }
  const staticMs = Date.now() - tStatic

  const preClusters = statics.report.clusters ?? []
  const staticSafe = preClusters.filter((c) => AUTO_SAFE_RULES.has(c.ruleId))
  // aiOnly 规则必须交给 AI 判定（静态永远不命中）
  const aiOnlyCandidates = [...AUTO_SAFE_RULES].filter((id) => AI_ONLY_SAFE_RULES.has(id))
  const focusedRules = requested
    ? [...new Set(requested)]
    : [...new Set([...staticSafe.map((c) => c.ruleId), ...aiOnlyCandidates])]
  void staticSafe

  stage(2, 6, `AI 复核选中规则 ${focusedRules.join(", ") || "无"}（${ANALYZER_TIER} 档，可能要 1~3 分钟，请等待）`)
  const tAi = Date.now()
  const before = await analyzeWorkflow({
    ...(resolved.kind === "directory" ? { dirPath: resolved.root } : { scriptPath: path.join(resolved.root, path.basename(resolved.ref)) }),
    cwd,
    includeRuleCheck: focusedRules.length > 0,
    ...(focusedRules.length > 0
      ? { ruleCheckAgent: createPlannerAgent({ cwd, tier: ANALYZER_TIER }), aiRules: focusedRules }
      : {}),
    includeSuggestions: false,
    format: "md",
  })
  const aiMs = Date.now() - tAi
  const timings = { staticMs, aiMs }
  if (!before.ok || !before.report) {
    return notify(`分析失败：${before.error ?? "unknown"}`, "warning")
  }

  // ② 选问题簇：静态簇 + aiOnly 规则由 AI 复核产生的「虚拟簇」
  const allClusters = [...(before.report.clusters ?? [])]
  // aiOnly 规则命中时，用 checks[].evidence 构造簇——否则这类规则在 optimize 里不可达
  for (const c of before.report.aiRuleCheck?.checks ?? []) {
    if (c.status !== "hit") continue
    if (!AI_ONLY_SAFE_RULES.has(c.ruleId) && !requested?.includes(c.ruleId)) continue
    if (allClusters.some((x) => x.ruleId === c.ruleId)) continue
    const files = [...new Set(c.evidence.map((e) => e.file))]
    const locations = c.evidence.map((e) => `${e.file}:L${e.startLine}-${e.endLine}`)
    allClusters.push({
      key: c.ruleId,
      ruleId: c.ruleId,
      severity: "high" as const,
      count: c.evidence.length,
      files,
      locations,
      moreLocations: 0,
      evidence: [c.reason, ...c.evidence.map((e) => `${e.file}:L${e.startLine} ${e.quote.slice(0, 120)}`)],
      confidence: c.confidence,
    })
  }
  const selected = requested
    ? allClusters.filter((c) => requested.includes(c.ruleId))
    : allClusters.filter((c) => AUTO_SAFE_RULES.has(c.ruleId))

  // ③ 建会话
  const id = nextSessionId(cwd)
  const p = sessionPaths(cwd, id)
  fs.mkdirSync(p.dir, { recursive: true })
  fs.writeFileSync(p.beforeMd, before.rendered ?? "", "utf8")
  fs.writeFileSync(p.beforeJson, JSON.stringify(before.report, null, 2), "utf8")
  try {
    const d = writeDashboard({ report: before.report, outDir: p.dir, projectName: id, aiEnabled: true })
    fs.renameSync(d.htmlPath, p.beforeDashboard)
  } catch {
    /* dashboard 失败不影响优化主流程 */
  }

  const session: OptimizationSession = {
    schemaVersion: "1.0",
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "analyzed",
    target: {
      kind: resolved.kind,
      ref,
      root: resolved.root,
      sourceHashes: resolved.sourceHashes,
      files: resolved.files,
    },
    selectedClusters: selected.map((c) => c.key),
    model: {
      analyzerTier: ANALYZER_TIER,
      generatorTier: tier,
      ...(resolveTierModel(tier, cwd) ? { generatorModel: resolveTierModel(tier, cwd)! } : {}),
      reviewerTier: REVIEWER_TIER,
      ...(resolveTierModel(REVIEWER_TIER, cwd) ? { reviewerModel: resolveTierModel(REVIEWER_TIER, cwd)! } : {}),
    },
    workspace: { path: p.workspace, patchApplied: false },
    validation: { sourceUnchanged: "pass" },
  }
  writeSession(cwd, session)

  if (selected.length === 0) {
    updateSession(cwd, id, { status: "rejected", reason: "没有可安全自动优化的问题簇" })
    const unsafe = allClusters.filter((c) => AUTO_UNSAFE_RULES.has(c.ruleId)).map((c) => c.ruleId)
    return notify(
      [
        `[无可自动优化项] ${id}`,
        `静态问题簇 ${allClusters.length} 个，但没有落在可安全自动优化的规则内。`,
        unsafe.length ? `以下问题需人工处理（副作用/运行语义）：${[...new Set(unsafe)].join(", ")}` : "",
        "",
        `完整分析：${p.beforeMd}`,
      ]
        .filter(Boolean)
        .join("\n"),
      "warning",
    )
  }

  // ④ 复制隔离工作区
  stage(3, 6, `创建隔离工作区（复制 ${resolved.root} 下的文本文件）`)
  const wsCopy = copyWorkspace(resolved.root, p.workspace)
  const manifest = wsCopy.manifest
  // P2-7：工作区不完整时，后续所有静态/benchmark 结论都不可信 → 直接拒绝
  if (wsCopy.truncated) {
    updateSession(cwd, id, { status: "rejected", reason: "目标目录文件数超过上限，隔离工作区不完整" })
    return notify(
      [
        `[拒绝优化] ${id}`,
        `目标目录文件数超过隔离工作区上限（${manifest.files.length} 个已复制），工作区不完整。`,
        "在不完整的工作区上做的验证结论不可信，因此不生成候选。",
        "",
        "请缩小目标范围（指定单文件或更小目录）。",
      ].join("\n"),
      "warning",
    )
  }

  // ⑤ 生成补丁
  // 只传证据行附近的窗口（±40 行）：全文 + 规则文档会让 big 档超 240s（实测）
  // location.file 可能是绝对路径（单文件 target）或 basename（目录 target），
  // 统一用 basename 做键，否则 editable 过滤会全部失配 → 「证据里没有可识别的文件」。
  const evidenceLines = new Map<string, number[]>()
  const touchedFiles = new Set<string>()

  // 填充证据行号（basename 做键，兼容绝对路径与相对路径两种 location.file）
  for (const c of selected) {
    for (const loc of c.locations) {
      const m = /^(.*?):L(\d+)-(\d+)$/.exec(loc)
      if (!m) continue
      const base = path.basename(m[1]!.split(path.sep).join("/"))
      touchedFiles.add(base)
      const arr = evidenceLines.get(base) ?? []
      arr.push(Number(m[2]), Number(m[3]))
      evidenceLines.set(base, arr)
    }
  }

  // 单次只改 1 个文件：实测把 3 个文件全文（DET-001 命中跨 3 文件）塞进 big 档
  // prompt 会超 240s 超时。最小可行优先——一个文件改对了，再处理下一个。
  const candidates = resolved.sources.filter(
    (s) => touchedFiles.size === 0 || touchedFiles.has(path.basename(s.file)),
  )
  // P0 修复：用户显式指定的 target 文件必须优先。
  // 之前只按「行数最小」排序取首个 —— tree 聚合会把同目录 12 个文件都算进来，
  // 结果用户指定 1-scan-template.js，补丁却改到了更小的 6-merge-evidence.js。
  const userTargetBase = resolved.kind === "file" ? path.basename(resolved.ref) : undefined
  candidates.sort((a, b) => {
    const aIsTarget = userTargetBase !== undefined && path.basename(a.file) === userTargetBase
    const bIsTarget = userTargetBase !== undefined && path.basename(b.file) === userTargetBase
    if (aIsTarget !== bIsTarget) return aIsTarget ? -1 : 1
    return a.content.split("\n").length - b.content.split("\n").length
  })
  const editable = candidates.slice(0, 1)
  if (editable.length === 0) {
    updateSession(cwd, id, { status: "failed", reason: "问题簇证据未指向任何可编辑文件" })
    return notify(`[无法定位修改文件] ${id}：问题簇证据里没有可识别的文件`, "warning")
  }
  const docs = loadRuleDocs()
  const ruleDocs = docs.rules
    .filter((r) => selected.some((c) => c.ruleId === r.id))
    .map((r) => ({ id: r.id, doc: condenseRuleDoc(r.doc) }))

  for (const c of selected) {
    for (const loc of c.locations) {
      const m = /^(.*?):L(\d+)-(\d+)$/.exec(loc)
      if (!m) continue
      const base = path.basename(m[1]!.split(path.sep).join("/"))
      touchedFiles.add(base)
      const arr = evidenceLines.get(base) ?? []
      arr.push(Number(m[2]), Number(m[3]))
      evidenceLines.set(base, arr)
    }
  }
  const WINDOW = 40
  stage(4, 6, `生成补丁（${tier} 档，最多 1~4 分钟）`)
  let gen = await generatePatchSet(
    {
      clusters: selected,
      files: editable.map((f) => {
        const rel = toRelKey(f.file)
        const all = f.content.split("\n")
        const hash = resolved.sourceHashes[rel] ?? ""
        const touched = evidenceLines.get(path.basename(rel)) ?? []
        if (touched.length === 0) return { path: rel, content: f.content, hash }
        const start = Math.max(1, Math.min(...touched) - WINDOW)
        const end = Math.min(all.length, Math.max(...touched) + WINDOW)
        return {
          path: rel,
          content: all.slice(start - 1, end).join("\n"),
          hash,
          snippetStart: start,
          snippetEnd: end,
          totalLines: all.length,
        }
      }),
      ruleDocs,
      requiredValidation: [],
      report: before.report,
    },
    createPlannerAgent({ cwd, tier }),
  )

  // 实测：big 档生成补丁（复杂输出）常超 240s；超时则降级 fast 重试一次。
  // 不静默降级——reason 与 review 都会写明实际使用的档位。
  let usedTier = tier
  const genDiag: string[] = []
  // 超时重试一次（同档）：实测 fast 档生成同样有 provider 波动
  // （同一 prompt 有时 60s 完成、有时 >240s 超时）。重试一次比直接失败更实用，
  // 但不无限重试——两次都超时就明确报告，不假装成功。
  if ((!gen.ok || !gen.patch) && /超时|timeout/i.test(gen.error ?? "")) {
    genDiag.push(`生成器 "${tier}" 档超时（${gen.error}），已重试 1 次`)
    notify(`生成器 "${tier}" 档超时，重试 1 次…`, "info")
    const retry = await generatePatchSet(
      {
        clusters: selected,
        files: editable.map((f) => {
          const rel = toRelKey(f.file)
          const all = f.content.split("\n")
          const hash = resolved.sourceHashes[rel] ?? ""
          const touched = evidenceLines.get(path.basename(rel)) ?? []
          if (touched.length === 0) return { path: rel, content: f.content, hash }
          const start = Math.max(1, Math.min(...touched) - WINDOW)
          const end = Math.min(all.length, Math.max(...touched) + WINDOW)
          return {
            path: rel,
            content: all.slice(start - 1, end).join("\n"),
            hash,
            snippetStart: start,
            snippetEnd: end,
            totalLines: all.length,
          }
        }),
        ruleDocs,
        requiredValidation: [],
        report: before.report,
      },
      createPlannerAgent({ cwd, tier }),
    )
    if (retry.ok && retry.patch) {
      gen = retry
      if (retry.raw) fs.writeFileSync(path.join(p.dir, "patchset.raw.txt"), retry.raw, "utf8")
    }
  }

  if (!gen.ok || !gen.patch) {
    updateSession(cwd, id, { status: "failed", reason: `补丁生成失败：${gen.error ?? "unknown"}` })
    return notify(
      [`[补丁生成失败] ${id}`, `原因：${gen.error ?? "unknown"}`, "", `原文件未修改。分析报告：${p.beforeMd}`].join("\n"),
      "warning",
    )
  }
  fs.writeFileSync(p.patchset, JSON.stringify(gen.patch, null, 2), "utf8")
  // 模型原始输出必须落盘：空补丁时只有它能说明模型为什么没改
  if (gen.raw) fs.writeFileSync(path.join(p.dir, "patchset.raw.txt"), gen.raw, "utf8")

  // ⑥ 结构校验 + 应用（仅工作区）
  const validation = validatePatchSet(gen.patch, p.workspace)
  if (!validation.ok || !validation.normalized) {
    // 模型明确给出 needsHumanDecision = 「不能安全自动改」，这是有效结论，不是失败。
    const nhd = gen.patch.needsHumanDecision ?? []
    const onlyHumanDecision = nhd.length > 0 && (gen.patch.files?.length ?? 0) === 0
    if (onlyHumanDecision) {
      updateSession(cwd, id, {
        status: "analyzed",
        validation: { patchSchema: "unavailable", sourceUnchanged: "pass" },
        reason: "模型判定无法在不改变行为的前提下自动修改，需要人工决策",
      })
      const review = renderReview({
        session: readSession(cwd, id)!,
        clusters: selected,
        patch: gen.patch,
        blockers: [
          "模型已确认该问题成立，但判定**无法安全自动修改**（原因见第 2 节 needsHumanDecision）。",
          "这是有效结论，不是失败：原文件未改动，也没有生成不可信的补丁。",
        ],
      })
      fs.writeFileSync(p.review, review, "utf8")
      return notify(
        [
          "[需要人工决策] " + id,
          "",
          "目标：" + ref,
          "问题簇：" + selected.map((c) => c.ruleId).join(", "),
          "",
          "模型判定无法安全自动修改，原因：",
          ...nhd.flatMap((d) => ["- " + d.cluster + "：" + d.question.slice(0, 600), ...d.options.map((o) => "  · " + o)]),
          "",
          "原文件未修改。",
          "审阅：" + p.review,
        ].join("\n"),
        "warning",
      )
    }
    updateSession(cwd, id, { status: "rejected", validation: { patchSchema: "fail" }, reason: "补丁结构校验未通过" })
    const review = renderReview({
      session: readSession(cwd, id)!,
      clusters: selected,
      patch: gen.patch,
      patchIssues: validation.issues.map((i) => `${i.path}：${i.reason}`),
      blockers: ["补丁结构校验未通过，未应用到工作区。"],
    })
    fs.writeFileSync(p.review, review, "utf8")
    return notify(
      [`[补丁被拒绝] ${id}`, `结构校验问题 ${validation.issues.length} 项：`, ...validation.issues.slice(0, 5).map((i) => `- ${i.path}：${i.reason}`), "", `审阅：${p.review}`].join("\n"),
      "warning",
    )
  }

  const applied = applyPatchSet(validation.normalized, p.workspace)
  // 记录工作区最终内容 hash（apply 前校验 review 后未被改动）
  const wsHashes: Record<string, string> = {}
  for (const f of applied.files) {
    wsHashes[f.path] = f.afterHash
  }
  updateSession(cwd, id, {
    status: "patched",
    workspace: { path: p.workspace, patchApplied: true, hashes: wsHashes },
    validation: { patchSchema: "pass" },
  })

  // ⑦ 生产文件必须未被改动
  const changed = detectSourceChanges(resolved.root, resolved.sourceHashes)
  if (changed.length > 0) {
    updateSession(cwd, id, { status: "stale", validation: { sourceUnchanged: "fail", patchSchema: "pass" }, reason: "优化期间生产文件被改动" })
    return notify(
      [`[优化中止] ${id}`, "优化期间生产文件发生变化：", ...changed.slice(0, 5).map((c) => `- ${c.path}`), "", "请重新运行 optimize。"].join("\n"),
      "warning",
    )
  }
  updateSession(cwd, id, { validation: { sourceUnchanged: "pass" } })

  // ⑧ 补丁审查（fast）
  const diffs = applied.files.map((f) => ({
    path: f.path,
    diff: makeSimpleDiff(
      resolved.sources.find((s) => toRelKey(s.file) === f.path)?.content ?? "",
      fs.readFileSync(path.join(p.workspace, f.path), "utf8"),
      f.path,
    ),
    before: resolved.sources.find((s) => toRelKey(s.file) === f.path)?.content ?? "",
    after: fs.readFileSync(path.join(p.workspace, f.path), "utf8"),
  }))

  /**
   * 按 edit 行号构造 hunk（每处 ±2 行上下文）。
   * 不用通用 diff：我们已知每处 edit 的位置，精确渲染比 LCS 近似更可信。
   */
  const CP = 2
  const hunks = validation.normalized.files.flatMap((f) => {
    const beforeContent = resolved.sources.find((s) => toRelKey(s.file) === f.path)?.content ?? ""
    const lines = beforeContent.split("\n")
    return f.edits.map((e) => ({
      path: f.path,
      startLine: e.startLine,
      endLine: e.endLine,
      oldLines: lines.slice(e.startLine - 1, e.endLine),
      newLines: e.newText.split("\n"),
      contextBefore: lines.slice(Math.max(0, e.startLine - 1 - CP), e.startLine - 1),
      contextAfter: lines.slice(e.endLine, Math.min(lines.length, e.endLine + CP)),
      rationale: e.rationale,
    }))
  })

  let patchReview: PatchReview | undefined
  try {
    stage(5, 6, "补丁审查（fast 档）")
    const rv = await reviewPatch(
      {
        patch: validation.normalized,
        afterFiles: diffs.map((d) => ({ path: d.path, before: d.before, after: d.after })),
        requiredValidation: [],
        clusters: selected.map((c) => ({ ruleId: c.ruleId, evidence: c.evidence, ...(c.suggestion ? { suggestion: c.suggestion } : {}) })),
      },
      createPlannerAgent({ cwd, tier: REVIEWER_TIER }),
    )
    if (rv.ok && rv.review) patchReview = rv.review
  } catch {
    /* 审查失败不阻断静态结论，但 review 里会显示缺失 */
  }

  // ⑨ 工作区静态复检（确认目标规则已解决，且未新增严重问题）
  stage(6, 6, "工作区静态复检")
  const afterReport = await analyzeWorkflow({
    ...(resolved.kind === "directory" ? { dirPath: p.workspace } : { scriptPath: path.join(p.workspace, path.basename(resolved.ref)) }),
    cwd,
    includeRuleCheck: false,
    includeSuggestions: false,
    format: "md",
  })

  const afterFindings = afterReport.report?.summary.totalFindings ?? -1
  // aiOnly 规则（REC-002 等）静态层本来就不产出 cluster，after 又没重跑 AI 复核，
  // 所以「静态 cluster 消失」不能证明它已解决。必须区分「静态已验证」与「未验证」。
  const aiOnlySelected = selected.filter((c) => AI_ONLY_SAFE_RULES.has(c.ruleId))
  const staticTargetResolved = selected
    .filter((c) => !AI_ONLY_SAFE_RULES.has(c.ruleId))
    .every((c) => !(afterReport.report?.clusters ?? []).some((x) => x.ruleId === c.ruleId && x.count >= c.count))
  const targetResolved = staticTargetResolved && aiOnlySelected.length === 0
  const unresolvedNote = aiOnlySelected.length > 0 ? `${aiOnlySelected.map((c) => c.ruleId).join(",")} 未重新 AI 复核（O1 阶段 after 只跑静态），解决与否待验证` : ""
  const staticPass = afterReport.ok && afterFindings >= 0 && afterFindings <= before.report.summary.totalFindings
  if (afterReport.ok && afterReport.report) {
    fs.writeFileSync(path.join(p.dir, "after.report.json"), JSON.stringify(afterReport.report, null, 2), "utf8")
    fs.writeFileSync(path.join(p.dir, "after.report.md"), afterReport.rendered ?? "", "utf8")
  }

  const reviewDecision = patchReview?.decision ?? "needs-human"

  // ⑨b 真实 Benchmark（O2）：只有显式 --benchmark 才跑；复用抽出后的实现
  const benchResult =
    argv.includes("--benchmark") && staticPass && reviewDecision !== "reject"
      ? await benchmarkSession({
          sessionId: id,
          argv,
          ctx,
          deps,
          productionRoot: resolved.root,
          entryName: path.basename(resolved.ref),
          workspaceDir: p.workspace,
          sessionDir: p.dir,
        })
      : undefined
  const benchmarkText = benchResult?.text
  const benchmarkAccepted = benchResult?.accepted ?? false
  const qualityStatus: "pass" | "fail" | "unavailable" = benchResult?.quality ?? "unavailable"

  // ⑩ 状态：O1 阶段没有真实 Benchmark，因此只能到 benchmark-pending，不能 ready
  const finalStatus =
    !staticPass || reviewDecision === "reject"
      ? "rejected"
      : benchmarkAccepted
        ? "ready"
        : "benchmark-pending"
  const blockers: string[] = [...genDiag]
  blockers.push(`耗时：静态 ${(timings.staticMs / 1000).toFixed(0)}s + AI 复核 ${(timings.aiMs / 1000).toFixed(0)}s（${ANALYZER_TIER} 档，${focusedRules.join(",") || "无"}）`)
  if (!staticPass) blockers.push("静态复检未通过（问题数增加或目标规则未解决），拒绝应用。")
  if (reviewDecision === "reject") blockers.push("补丁审查判定 reject，拒绝应用。")
  if (benchmarkText) {
    blockers.push(benchmarkAccepted ? "真实 Benchmark 通过：可申请写回（apply）。" : "真实 Benchmark 未通过，禁止 apply（原因见 benchmark.md）。")
  } else {
    blockers.push("未运行真实 Benchmark（加 --benchmark --args '<json>' 触发）：当前只有静态与 AI 复核证据，**不能写回生产文件**。")
  }

  updateSession(cwd, id, {
    status: finalStatus,
    validation: {
      static: staticPass ? "pass" : "fail",
      aiRuleCheck: "unavailable",
      benchmark: benchmarkText ? (benchmarkAccepted ? "pass" : "fail") : "pending",
      quality: benchmarkText ? qualityStatus : "pending",
    },
    reason: blockers[0],
  })

  // 各簇处理情况：按「补丁里是否有该 ruleId 的 edit」判定，未处理的给出可读原因。
  // 实测选中 4 个簇只改了 1 处时，旧 review 完全没说另 3 个为什么没动。
  const handledRuleIds = new Set(validation.normalized.files.flatMap((f) => f.edits.map((e) => e.relatedCluster)))
  const clusterOutcome = selected.map((c) => {
    if (handledRuleIds.has(c.ruleId)) return { ruleId: c.ruleId, status: "handled" as const }
    if (handledRuleIds.size === 0) {
      return {
        ruleId: c.ruleId,
        status: "needs-human" as const,
        reason: "模型未给出可应用的补丁（原因见第 2 节 needsHumanDecision）",
      }
    }
    return {
      ruleId: c.ruleId,
      status: "skipped" as const,
      reason: "本轮只改 1 个文件（输出预算与超时限制），该簇需下一批次单独跑 optimize",
    }
  })

  const reviewMd = renderReview({
    session: readSession(cwd, id)!,
    clusters: selected,
    patch: validation.normalized,
    clusterOutcome,
    ...(patchReview ? { patchReview } : {}),
    diffs: diffs.map((d) => ({ path: d.path, diff: d.diff })),
    staticAfter: { totalFindings: afterFindings, targetRuleResolved: targetResolved },
    blockers,
  })
  fs.writeFileSync(p.review, reviewMd, "utf8")

  const files = validation.normalized.files.length
  const edits = validation.normalized.files.reduce((n, f) => n + f.edits.length, 0)

  // 生成 HTML 报告（零依赖，file:// 可直开），供写完摘要后自动打开
  let reportPath: string | undefined
  try {
    reportPath = writeOptimizeReport({
      dir: p.dir,
      // 复用 after 的完整分析结果：optimize 报告必须是「完整分析 + 优化 Tab」，
      // 不能只给优化信息——否则比 anal 的 dashboard 少掉规则清单/问题列表/子流程明细。
      report: afterReport.ok && afterReport.report ? afterReport.report : before.report,
      aiEnabled: true,
      optimize: {
        id,
        status: finalStatus,
        target: ref,
        beforeFindings: before.report.summary.totalFindings,
        afterFindings,
        aiMs: timings.aiMs,
        files: validation.normalized.files.map((f) => ({ path: f.path, edits: f.edits.length })),
        clusters: selected.map((c) => {
          const oc = clusterOutcome.find((o) => o.ruleId === c.ruleId)
          return {
            ruleId: c.ruleId,
            count: c.count,
            severity: c.severity,
            confidence: c.confidence,
            status: oc?.status ?? "skipped",
            ...(oc?.reason ? { reason: oc.reason } : {}),
          }
        }),
        hunks,
        ...(patchReview ? { patchReview } : {}),
        blockers,
        // 下一步命令：让用户在报告里直接看到怎么继续，不用回查文档
        nextStep:
          finalStatus === "benchmark-pending"
            ? `/workflows optimize ${ref} --benchmark --args {"runDir":"spec-workflow/bench"} --verify-cmd "node verify.mjs"   # 换成该 workflow 要求的必填 args（如 runDir / date）`
            : finalStatus === "ready"
              ? `/workflows optimize apply ${id}`
              : `查看 ${p.review} 了解拒绝原因；调整 --rules 或目标后重跑`,
      },
    })
  } catch {
    reportPath = undefined
  }

  const summaryText = [
    finalStatus === "rejected" ? `[候选被拒绝] ${id}` : `[优化候选待验证] ${id}`,
    "",
    `目标：${ref}`,
    `问题簇：${selected.map((c) => c.ruleId).join(", ")}`,
    `修改：${files} 个文件 / ${edits} 处补丁`,
    // 必须列出具体文件：已知失败形态是「改对了但改错了地方」，
    // 只写「1 个文件」用户没法发现改错目标。
    ...validation.normalized.files.map((f) => `  - ${f.path}（${f.edits.length} 处）`),
    `静态：${before.report.summary.totalFindings} 条 → ${afterFindings} 条${targetResolved ? "（目标规则已解决）" : staticTargetResolved ? "（静态未新增）" : "（目标规则仍在）"}`,
    ...(unresolvedNote ? [`注意：${unresolvedNote}`] : []),
    patchReview ? `补丁审查：${patchReview.decision}${patchReview.findings.length ? `（${patchReview.findings.length} 项发现）` : ""}` : "补丁审查：未完成",
    "",
    "原文件未修改。",
    ...(blockers.length ? ["", ...blockers.map((b) => `- ${b}`)] : []),
    "",
    `报告：${reportPath ?? p.review}`,
    `工作区：${p.workspace}（${manifest.files.length} 个文件已复制）`,
  ].join("\n")
  notify(summaryText, finalStatus === "rejected" ? "warning" : "info")

  // 自动打开报告：optimize 完成后的产物就是「改了什么 + diff + 审查 + 结论」，
  // 用户明确要求完成后能看到报告。--no-open 或 CI 环境跳过。
  if (reportPath && !argv.includes("--no-open") && shouldAutoOpen().open) {
    const r = await openInBrowser(reportPath)
    if (!r.ok) notify(`报告已生成但打开失败（${r.error?.slice(0, 60)}）：${reportPath}`, "warning")
  }

  // 后台模式下命令已提前返回，需要把摘要 return 出去交给 deliver 回传；
  // 同时把最后一个阶段节点收尾成 ok（否则 status 里永远显示 running）
  runtime?.sealStage()
  return summaryText
}

/**
 * 给指定会话跑真实 Benchmark（before: 生产目录 / after: 隔离工作区）。
 *
 * 抽成独立函数的原因：benchmark 必须能作用于**已有候选**。
 * 之前它内联在 optimize 流程里，导致「第一次生成补丁、第二次想验证」必然新建会话，
 * benchmark 实际不可达，apply 永远到不了 ready。
 */
async function benchmarkSession(input: {
  sessionId: string
  argv: string[]
  ctx: any
  deps: any
  productionRoot: string
  entryName: string
  workspaceDir: string
  sessionDir: string
}): Promise<{ accepted: boolean; quality: "pass" | "fail" | "unavailable"; text: string; error?: string } | undefined> {
  const { sessionId, argv, ctx, deps, productionRoot, entryName, workspaceDir, sessionDir } = input
  const argsRaw = flagValue(argv, "--args")

  // 硬前置：多数 workflow 的入口参数是必填（如 runDir / date），
  // 缺了会让 before/after 都手抛错——提前说清楚，别让用户看一堆 workflow 堆栈。
  if (!argsRaw) {
    const msg = "缺少 --args：真实 Benchmark 需要入口参数（如 runDir / date），否则 workflow 直接报必填错误。\n 示例：--args '{\"runDir\":\"spec-workflow/bench\"}'"
    updateSession(path.dirname(path.dirname(sessionDir)), sessionId, { status: "failed", reason: msg })
    return { accepted: false, quality: "unavailable", text: msg, error: msg }
  }
  let benchArgs: Record<string, unknown> = {}
  if (argsRaw) {
    try {
      benchArgs = JSON.parse(argsRaw)
    } catch (e) {
      const msg = `--args 不是合法 JSON：${argsRaw}\n（${String((e as Error)?.message ?? e)}）\n注意：pi 的命令行不是 shell（不做引号解析），不要加外层引号，直接写：--args {"runDir":"spec-workflow/bench"}`
      updateSession(path.dirname(path.dirname(sessionDir)), sessionId, { status: "failed", reason: msg })
      return { accepted: false, quality: "unavailable", text: msg, error: msg }
    }
  }
  const verifierCmd = flagValue(argv, "--verify-cmd")
  const qualityGate = verifierCmd ? ({ kind: "verifier", command: verifierCmd } as const) : ({ kind: "none" } as const)

  // 项目根：workflow 里的相对路径（如 templatePath 默认 templates/...）是相对**项目根**的，
  // 不是相对脚本目录。用 target 目录当 cwd 会让依赖项目根的 workflow 直接跑不起来。
  const projectRoot = findProjectRoot(productionRoot)
  const runDirs: Record<"before" | "after", string | undefined> = { before: undefined, after: undefined }

  let verifierResult: VerifierResult | undefined
  const runOnce = async (label: "before" | "after"): Promise<RealRunOutcome> => {
    // 脚本：before 用生产原版，after 用隔离工作区版本；两者都在项目根下运行
    const scriptAbs = label === "before" ? path.join(productionRoot, entryName) : path.join(workspaceDir, entryName)
    // runDir 隔离：给 --args 里的 runDir 追加 -before / -after，避免两次写同一目录
    const runArgs = benchArgs.runDir ? { ...benchArgs, runDir: `${String(benchArgs.runDir)}-${label}` } : benchArgs
    // 存**绝对路径**：verifier 的 cwd 是脚本目录，不是项目根，相对路径在那边解析不到
    if (typeof runArgs.runDir === "string") runDirs[label] = path.resolve(projectRoot, runArgs.runDir)
    const tool = makeWorkflowTool({ ...deps.makeDeps(projectRoot), deliver: deps.deliver })
    const t0 = Date.now()
    const out: any = await tool.execute("bench", { scriptPath: scriptAbs, args: runArgs, background: false }, undefined, undefined, undefined)
    const durationMs = Date.now() - t0
    const text: string = out?.content?.[0]?.text ?? ""
    const failed = Boolean(out?.isError) || /\[workflow 失败\]|执行失败/.test(text)
    const idMatch = /runId=([A-Za-z0-9_-]+)/.exec(text)
    const runId = idMatch?.[1]
    const detail = runId ? deps.runManager.status(runId) : undefined
    if (!runId || !detail) {
      return { ok: false, durationMs, agents: 0, failedAgents: 0, error: `无法确定本次 runId（${runId ?? "解析失败"}），指标不可信` }
    }
    const agents = detail.agents ?? []
    const tokenSum = agents.reduce((n: number, a: any) => n + (a.tokens ?? 0), 0)
    return {
      ok: !failed && detail.status !== "failed",
      durationMs,
      agents: agents.length,
      inputTokens: tokenSum > 0 ? tokenSum : undefined,
      failedAgents: agents.filter((a: any) => a.status === "failed" || a.status === "aborted").length,
      ...(failed ? { error: text.slice(0, 200) } : {}),
    }
  }

  // 后台模式下不碰 TUI（ctx.ui 可能已失效）；仅作日志，摘要由调用方 deliver
  console.log(
    [
      "[optimize] 运行真实 Benchmark：",
      `  before：生产目录 ${productionRoot}（会在真实目录执行一次 workflow）`,
      `  after ：隔离工作区 ${workspaceDir}`,
      `  args  ：${JSON.stringify(benchArgs)}`,
    ].join("\n"),
  )
  const verdict = await runRealBenchmark({
    scriptPath: path.join(productionRoot, entryName),
    cwd: productionRoot,
    run: ({ label }) => runOnce(label),
    qualityGate,
    ...(verifierCmd
      ? {
          runVerifier: async (cmd: string) => {
            // cwd 用项目根：verifier 要能读到 runDir 产物（相对项目根）。
            // 同时注入两次 runDir，让 verifier 能对比 before/after 产物是否等价 ——
            // 这才是「质量未降级」的直接证据。
            // cwd = 脚本所在目录：用户写的 `node verify.mjs` 等相对路径是相对这个目录的
            // （projectRoot 是给 workflow 用的，用来解析 templates/ 这类项目级相对路径）
            const vr = await runVerifierCommand({
              command: cmd,
              cwd: productionRoot,
              env: {
                ...(runDirs.before ? { PI_OPT_BEFORE_RUN: runDirs.before } : {}),
                ...(runDirs.after ? { PI_OPT_AFTER_RUN: runDirs.after } : {}),
                PI_OPT_PROJECT_ROOT: projectRoot,
              },
            })
            verifierResult = vr
            return { ok: vr.ok, output: vr.note }
          },
        }
      : {}),
  })
  const text = renderBenchmarkVerdict(verdict)
  const verifierSection = verifierCmd && verifierResult ? `\n\n## Verifier\n\n${renderVerifier(verifierResult, verifierCmd)}\n` : ""
  fs.writeFileSync(path.join(sessionDir, "benchmark.md"), `# Benchmark\n\n${text}${verifierSection}\n`, "utf8")
  return { accepted: verdict.accepted, quality: verdict.quality.status, text }

}

// ---------------------------------------------------------------- apply / rollback（O3）

async function runApply(argv: string[], ctx: any, deps: any): Promise<void> {
  const id = argv.find((a) => !a.startsWith("--"))
  const cwd = ctx.cwd ?? process.cwd()
  if (!id) {
    ctx.ui.notify("用法：/workflows optimize apply <优化编号>", "warning")
    return
  }
  const s = readSession(cwd, id)
  if (!s) {
    ctx.ui.notify(`找不到优化会话：${id}`, "warning")
    return
  }

  // 只有 ready 才能写回：benchmark-pending / analyzed / rejected 一律拒绝。
  // 这是「无真实质量验证不得改生产文件」的最终闸门。
  if (s.status !== "ready") {
    const why: Record<string, string> = {
      "benchmark-pending": "尚未通过真实 Benchmark 与质量门",
      analyzed: "只完成分析（或需要人工决策）",
      rejected: "候选已被拒绝",
      applied: "已经应用过（如需重放请先 rollback）",
      stale: "源文件已变化，请重新运行 optimize",
    }
    ctx.ui.notify(
      [
        `[拒绝写回] ${id}`,
        `当前状态：${s.status}（${why[s.status] ?? "不可写回"}）`,
        "",
        s.status === "benchmark-pending"
          ? `先运行：/workflows optimize ${s.target.ref} --benchmark --args '<json>' --verify-cmd '<cmd>'`
          : `审阅：${sessionPaths(cwd, id).review}`,
      ].join("\n"),
      "warning",
    )
    return
  }

  const p = sessionPaths(cwd, id)
  const patchsetPath = p.patchset
  if (!fs.existsSync(patchsetPath)) {
    ctx.ui.notify(`缺少 patchset.json，无法写回：${patchsetPath}`, "warning")
    return
  }
  const patch = JSON.parse(fs.readFileSync(patchsetPath, "utf8")) as PatchSet

  // 待写回内容取自工作区（patch 已应用）；同时校验 workspace 未被改动。
  // P1-5：review/benchmark 后 workspace 可能被人工或其他进程改动，
  // 若不校验就会出现「审阅 A、写回 B」。
  const reviewedHashes = s.workspace.hashes ?? {}
  const driftedWorkspace: string[] = []
  const items = patch.files.map((f) => {
    const wsFile = path.join(p.workspace, f.path)
    const content = fs.readFileSync(wsFile, "utf8")
    const recorded = reviewedHashes[f.path]
    if (recorded && sha256Of(content) !== recorded) driftedWorkspace.push(f.path)
    return {
      path: f.path,
      content,
      expectedSourceHash: s.target.sourceHashes[f.path] ?? f.expectedSourceHash,
    }
  })
  if (driftedWorkspace.length > 0) {
    updateSession(cwd, id, { status: "stale", reason: "workspace 内容在 review 后被改动" })
    ctx.ui.notify(
      [`[拒绝写回] ${id}`, "工作区内容在 review 之后被改动，写回内容已不是审阅/验证过的那份：", ...driftedWorkspace.map((x) => `- ${x}`), "", "请重新运行 optimize。"].join("\n"),
      "warning",
    )
    return
  }

  const r = applyToProduction({
    sessionDir: p.dir,
    optimizationId: id,
    targetRoot: s.target.root,
    items,
  })

  if (!r.ok) {
    const staleNow = Boolean(r.stale?.length)
    if (staleNow) updateSession(cwd, id, { status: "stale", reason: r.error })
    // P1-4：部分写入失败 → 显式状态，让 rollback 能兜底（此前停在 ready，rollback 被状态门挡住）
    else updateSession(cwd, id, { status: "applied", reason: `部分写入失败：${r.error}`, appliedFiles: r.applied.length })
    ctx.ui.notify(
      [
        `[写回失败] ${id}`,
        r.error ?? "unknown",
        ...(r.stale ? r.stale.map((x) => `- ${x.path}：期望 ${x.expected.slice(0, 15)}… 实际 ${x.actual?.slice(0, 15) ?? "(缺失)"}`) : []),
        "",
        staleNow ? "源文件已变化，请重新运行 optimize。" : `已备份的文件可用 rollback 恢复：${p.dir}`,
      ].join("\n"),
      "warning",
    )
    return
  }

  updateSession(cwd, id, { status: "applied", appliedFiles: r.applied.length })

  // 应用后重新分析（I6）：失败不自动回滚，保留新状态 + backup 供用户决定
  let afterNote = ""
  try {
    const after = await analyzeWorkflow({
      dirPath: s.target.kind === "directory" ? s.target.root : undefined,
      ...(s.target.kind !== "directory" ? { scriptPath: path.join(s.target.root, path.basename(s.target.ref)) } : {}),
      cwd,
      includeRuleCheck: false,
      includeSuggestions: false,
      format: "md",
    })
    if (after.ok && after.report) {
      fs.writeFileSync(path.join(p.dir, "applied.report.json"), JSON.stringify(after.report, null, 2), "utf8")
      fs.writeFileSync(path.join(p.dir, "applied.report.md"), after.rendered ?? "", "utf8")
      afterNote = `应用后重分析：${after.report.summary.totalFindings} 条 finding（已落盘 applied.report.md）`
    } else {
      afterNote = `应用后重分析失败（不自动回滚）：${after.error ?? "unknown"}`
    }
  } catch (e) {
    afterNote = `应用后重分析异常（不自动回滚）：${String((e as Error)?.message ?? e).slice(0, 120)}`
  }

  fs.writeFileSync(
    p.result,
    JSON.stringify({ appliedAt: new Date().toISOString(), files: r.applied, note: afterNote }, null, 2),
    "utf8",
  )

  ctx.ui.notify(
    [
      `[已写回] ${id}`,
      "",
      `修改文件：${r.applied.length} 个`,
      ...r.applied.map((x) => `- ${x.path}`),
      "",
      afterNote,
      "",
      `备份：${path.join(p.backup, "manifest.json")}`,
      `回滚：/workflows optimize rollback ${id}`,
    ].join("\n"),
    "info",
  )
  void deps
}

async function runRollback(argv: string[], ctx: any, deps: any): Promise<void> {
  const id = argv.find((a) => !a.startsWith("--"))
  const force = argv.includes("--force")
  const cwd = ctx.cwd ?? process.cwd()
  if (!id) {
    ctx.ui.notify("用法：/workflows optimize rollback <优化编号> [--force]", "warning")
    return
  }
  const s = readSession(cwd, id)
  if (!s) {
    ctx.ui.notify(`找不到优化会话：${id}`, "warning")
    return
  }
  // P1-4：部分写入失败时状态也是 "applied"（reason 里注明），因此这里放行。
  // 只要 backup manifest 存在就能恢复——这是故障兜底路径，不该被状态门挡死。
  const rollbackable = s.status === "applied" || s.status === "ready"
  if (!rollbackable) {
    ctx.ui.notify(`[拒绝回滚] ${id}：当前状态 ${s.status}（只有已应用/部分写入的会话才能回滚）`, "warning")
    return
  }
  const p = sessionPaths(cwd, id)
  const manifest = readBackupManifest(p.dir)
  if (!manifest) {
    ctx.ui.notify(`缺少 backup/manifest.json，无法回滚：${p.backup}`, "warning")
    return
  }

  const r = rollbackFromBackup({ sessionDir: p.dir, manifest, force })
  if (!r.ok) {
    ctx.ui.notify(
      [
        `[回滚失败] ${id}`,
        r.error ?? "unknown",
        ...(r.drifted ? r.drifted.map((x) => `- ${x.path}：apply 后已被改动`) : []),
      ].join("\n"),
      "warning",
    )
    return
  }

  updateSession(cwd, id, { status: "rolled-back", reason: `回滚 ${r.restored.length} 个文件` })

  let afterNote = ""
  try {
    const after = await analyzeWorkflow({
      dirPath: s.target.kind === "directory" ? s.target.root : undefined,
      ...(s.target.kind !== "directory" ? { scriptPath: path.join(s.target.root, path.basename(s.target.ref)) } : {}),
      cwd,
      includeRuleCheck: false,
      includeSuggestions: false,
      format: "md",
    })
    if (after.ok && after.report) {
      fs.writeFileSync(path.join(p.dir, "rolledback.report.md"), after.rendered ?? "", "utf8")
      afterNote = `回滚后重分析：${after.report.summary.totalFindings} 条 finding`
    }
  } catch {
    /* 回滚后重分析失败不影响回滚结果 */
  }

  ctx.ui.notify(
    [`[已回滚] ${id}`, "", `恢复文件：${r.restored.length} 个`, ...r.restored.map((x) => `- ${x}`), "", afterNote]
      .filter(Boolean)
      .join("\n"),
    "info",
  )
  void deps
}

/**
 * 生成 optimize 的 HTML 报告（结构化直出，不经 markdown）。
 *
 * 之前把 review.md 原文塞进 <pre>，浏览器里看到的是 ## / | 表格 | / ```diff 这些原始标记。
 * 这里直接用 session / patch / review / diffs 数据渲染卡片、表格与带颜色的 diff。
 */
/**
 * 从任意目录向上找项目根：含 .opencode-workflows / templates / package.json 的目录。
 *
 * workflow 里的相对路径（如 templatePath 默认 templates/...）是相对**项目根**解析的，
 * 用 target 目录当 cwd 会让依赖项目根的 workflow 直接跑不起来。
 */
function findProjectRoot(fromDir: string): string {
  let dir = path.resolve(fromDir)
  for (let i = 0; i < 12; i++) {
    if (
      fs.existsSync(path.join(dir, ".opencode-workflows")) ||
      fs.existsSync(path.join(dir, "templates")) ||
      fs.existsSync(path.join(dir, "package.json"))
    ) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(fromDir)
}

/**
 * 生成 optimize 的 HTML 报告 = **完整分析 Dashboard + 优化 Tab**。
 *
 * 为什么不是精简版：optimize 跑完本来就是完整分析（afterReport），
 * 另做一个只含补丁/diff 的页面会丢掉规则清单、问题列表、子 workflow 明细、AI 建议 ——
 * 用户看 optimize 报告时就没法复核「这些问题是不是真的」。
 */
function writeOptimizeReport(input: {
  dir: string
  report: AnalysisReport
  aiEnabled?: boolean
  optimize: NonNullable<DashboardView["optimize"]>
}): string {
  const view = buildDashboardView(input.report, { ...(input.aiEnabled !== undefined ? { aiEnabled: input.aiEnabled } : {}) })
  view.optimize = input.optimize
  // aiEnabled 在 optimize 场景恒为 true（分析阶段跑过 AI 复核）
  view.meta.aiEnabled = true
  const file = path.join(input.dir, "optimize-report.html")
  fs.writeFileSync(file, renderDashboardHtml(view), "utf8")
  return file
}

/** 简易 unified diff（按行 LCS 太重，这里只做前后行对比，足够 review 阅读） */
function makeSimpleDiff(before: string, after: string, filePath: string): string {
  const a = before.split("\n")
  const b = after.split("\n")
  const out: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`]
  const max = Math.max(a.length, b.length)
  let start = 0
  while (start < max && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  if (start > endA && start > endB) return `${out.join("\n")}\n（无差异）`
  out.push(`@@ -${start + 1},${Math.max(1, endA - start + 1)} +${start + 1},${Math.max(1, endB - start + 1)} @@`)
  for (let i = start; i <= endA; i++) out.push(`-${a[i] ?? ""}`)
  for (let i = start; i <= endB; i++) out.push(`+${b[i] ?? ""}`)
  return out.join("\n")
}
