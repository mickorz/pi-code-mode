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
import { writeDashboard } from "../../../../src/engine/analyzer/dashboard/build-dashboard.js"
import { generatePatchSet } from "../../../../src/engine/optimizer/patch-generator.js"
import { reviewPatch } from "../../../../src/engine/optimizer/patch-reviewer.js"
import { applyPatchSet, validatePatchSet } from "../../../../src/engine/optimizer/patch-validator.js"
import { renderReview } from "../../../../src/engine/optimizer/review-renderer.js"
import { renderBenchmarkVerdict, runRealBenchmark, type RealRunOutcome } from "../../../../src/engine/optimizer/benchmark-adapter.js"
import { applyToProduction, readBackupManifest, rollbackFromBackup } from "../../../../src/engine/optimizer/apply-service.js"
import { renderVerifier, runVerifierCommand, type VerifierResult } from "../../../../src/engine/optimizer/verifier-runner.js"
import { makeWorkflowTool } from "../../../../src/tools/workflow-tools.js"
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
const AUTO_SAFE_RULES = new Set(["DET-001", "IO-001", "REC-002"])
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

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

// ---------------------------------------------------------------- optimize

async function runOptimize(ref: string, argv: string[], ctx: any, deps: any): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd()
  const fresh = argv.includes("--fresh")
  const tier = flagValue(argv, "--tier") ?? GENERATOR_TIER
  const rulesArg = flagValue(argv, "--rules")
  const requested = rulesArg ? rulesArg.split(",").map((s) => s.trim()).filter(Boolean) : undefined

  // 同 target 的未完成会话：默认继续，--fresh 才新建（避免用户重复跑丢掉已验证工作）
  if (!fresh) {
    const open = findOpenSession(cwd, ref)
    if (open) {
      const p = sessionPaths(cwd, open.id)
      ctx.ui.notify(
        [
          `发现该目标未完成的优化候选：${open.id}（状态 ${open.status}）`,
          `审阅：${p.review}`,
          "",
          "继续处理该候选；如需重新生成请加 --fresh。",
        ].join("\n"),
        "info",
      )
      return
    }
  }

  const resolved = resolveTarget(cwd, ref)
  if (typeof resolved === "string") {
    ctx.ui.notify(resolved, "warning")
    return
  }

  ctx.ui.notify(`分析中…\n${ref}\n（${resolved.files.length} 个 js 文件）`, "info")

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
    ctx.ui.notify(`静态分析失败：${statics.error ?? "unknown"}`, "warning")
    return
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
    ctx.ui.notify(`分析失败：${before.error ?? "unknown"}`, "warning")
    return
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
    ctx.ui.notify(
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
    return
  }

  // ④ 复制隔离工作区
  const { manifest } = copyWorkspace(resolved.root, p.workspace)

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
  candidates.sort((a, b) => a.content.split("\n").length - b.content.split("\n").length)
  const editable = candidates.slice(0, 1)
  if (editable.length === 0) {
    updateSession(cwd, id, { status: "failed", reason: "问题簇证据未指向任何可编辑文件" })
    ctx.ui.notify(`[无法定位修改文件] ${id}：问题簇证据里没有可识别的文件`, "warning")
    return
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
    ctx.ui.notify(`生成器 "${tier}" 档超时，重试 1 次…`, "info")
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
    ctx.ui.notify(
      [`[补丁生成失败] ${id}`, `原因：${gen.error ?? "unknown"}`, "", `原文件未修改。分析报告：${p.beforeMd}`].join("\n"),
      "warning",
    )
    return
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
      ctx.ui.notify(
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
      return
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
    ctx.ui.notify(
      [`[补丁被拒绝] ${id}`, `结构校验问题 ${validation.issues.length} 项：`, ...validation.issues.slice(0, 5).map((i) => `- ${i.path}：${i.reason}`), "", `审阅：${p.review}`].join("\n"),
      "warning",
    )
    return
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
    ctx.ui.notify(
      [`[优化中止] ${id}`, "优化期间生产文件发生变化：", ...changed.slice(0, 5).map((c) => `- ${c.path}`), "", "请重新运行 optimize。"].join("\n"),
      "warning",
    )
    return
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

  let patchReview: PatchReview | undefined
  try {
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

  // ⑨b 真实 Benchmark（O2，显式开启）：--benchmark --args '<json>'
  // 默认不跑：game-requirement-audit 这类脚本单次 run 几十分钟，before/after 就是 1~2 小时。
  // 用户必须明确要求并给出 args（多数 workflow 需要 date 等必填参数）。
  let benchmarkText: string | undefined
  let verifierResult: VerifierResult | undefined
  let benchmarkAccepted = false
  let qualityStatus: "pass" | "fail" | "unavailable" = "unavailable"
  const benchEnabled = argv.includes("--benchmark")
  if (benchEnabled && staticPass && reviewDecision !== "reject") {
    const argsRaw = flagValue(argv, "--args")
    let benchArgs: Record<string, unknown> = {}
    if (argsRaw) {
      try {
        benchArgs = JSON.parse(argsRaw)
      } catch {
        ctx.ui.notify(`--args 不是合法 JSON：${argsRaw}`, "warning")
        return
      }
    }
    const verifierCmd = flagValue(argv, "--verify-cmd")
    const qualityGate = verifierCmd
      ? ({ kind: "verifier", command: verifierCmd } as const)
      : ({ kind: "none" } as const)

    // 复用 workflow 工具真实执行：before 用生产目录，after 用隔离工作区
    const runOnce = async (label: "before" | "after"): Promise<RealRunOutcome> => {
      const root = label === "before" ? resolved.root : p.workspace
      const scriptAbs = path.join(root, path.basename(resolved.ref))
      const tool = makeWorkflowTool({ ...deps.makeDeps(root), deliver: deps.deliver })
      const t0 = Date.now()
      const out: any = await tool.execute("bench", { scriptPath: scriptAbs, args: benchArgs, background: false }, undefined, undefined, undefined)
      const durationMs = Date.now() - t0
      const text: string = out?.content?.[0]?.text ?? ""
      const failed = Boolean(out?.isError) || /\[workflow 失败\]|执行失败/.test(text)

      // P0-4：绝不猜 runId。此前用 runManager.list()[0]，并发时可能拿到别的 run
      // 的 agents/tokens/failedAgents，before/after 判定建立在错误数据上。
      const idMatch = /runId=([A-Za-z0-9_-]+)/.exec(text)
      const runId = idMatch?.[1]
      const detail = runId ? deps.runManager.status(runId) : undefined
      if (!runId || !detail) {
        return {
          ok: false,
          durationMs,
          agents: 0,
          failedAgents: 0,
          error: `无法确定本次 runId（${runId ?? "解析失败"}），benchmark 指标不可信，按失败处理`,
        }
      }
      const agents = detail.agents ?? []
      const tokenSum = agents.reduce((n: number, a: any) => n + (a.tokens ?? 0), 0)
      return {
        ok: !failed && detail.status !== "failed",
        durationMs,
        agents: agents.length,
        // AgentRecord 只有 tokens 总量（无 input/output 拆分）：给 inputTokens，
        // outputTokens 保持 undefined —— 不虚构 0（这正是审计 M8 指出的问题）。
        inputTokens: tokenSum > 0 ? tokenSum : undefined,
        failedAgents: agents.filter((a: any) => a.status === "failed" || a.status === "aborted").length,
        ...(failed ? { error: text.slice(0, 200) } : {}),
      }
    }

    ctx.ui.notify(`运行真实 Benchmark（before: 生产目录 / after: 工作区，args=${JSON.stringify(benchArgs)}）…`, "info")
    const verdict = await runRealBenchmark({
      scriptPath: path.join(resolved.root, path.basename(resolved.ref)),
      cwd,
      run: ({ label }) => runOnce(label),
      qualityGate,
      // P0-1：真实执行 verifier，cwd = after 工作区（不在生产目录跑验证）
      ...(verifierCmd
        ? {
            runVerifier: async (cmd: string) => {
              const vr = await runVerifierCommand({ command: cmd, cwd: p.workspace })
              verifierResult = vr
              return { ok: vr.ok, output: vr.note }
            },
          }
        : {}),
    })
    benchmarkAccepted = verdict.accepted
    qualityStatus = verdict.quality.status
    benchmarkText = renderBenchmarkVerdict(verdict)
    const verifierSection = verifierCmd && verifierResult ? `\n\n## Verifier\n\n${renderVerifier(verifierResult, verifierCmd)}\n` : ""
    fs.writeFileSync(path.join(p.dir, "benchmark.md"), `# Benchmark\n\n${benchmarkText}${verifierSection}\n`, "utf8")
  }

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

  const reviewMd = renderReview({
    session: readSession(cwd, id)!,
    clusters: selected,
    patch: validation.normalized,
    ...(patchReview ? { patchReview } : {}),
    diffs: diffs.map((d) => ({ path: d.path, diff: d.diff })),
    staticAfter: { totalFindings: afterFindings, targetRuleResolved: targetResolved },
    blockers,
  })
  fs.writeFileSync(p.review, reviewMd, "utf8")

  const files = validation.normalized.files.length
  const edits = validation.normalized.files.reduce((n, f) => n + f.edits.length, 0)
  ctx.ui.notify(
    [
      finalStatus === "rejected" ? `[候选被拒绝] ${id}` : `[优化候选待验证] ${id}`,
      "",
      `目标：${ref}`,
      `问题簇：${selected.map((c) => c.ruleId).join(", ")}`,
      `修改：${files} 个文件 / ${edits} 处补丁`,
      `静态：${before.report.summary.totalFindings} 条 → ${afterFindings} 条${targetResolved ? "（目标规则已解决）" : staticTargetResolved ? "（静态未新增）" : "（目标规则仍在）"}`,
      ...(unresolvedNote ? [`注意：${unresolvedNote}`] : []),
      patchReview ? `补丁审查：${patchReview.decision}${patchReview.findings.length ? `（${patchReview.findings.length} 项发现）` : ""}` : "补丁审查：未完成",
      "",
      "原文件未修改。",
      ...(blockers.length ? ["", ...blockers.map((b) => `- ${b}`)] : []),
      "",
      `审阅：${p.review}`,
      `工作区：${p.workspace}（${manifest.files.length} 个文件已复制）`,
    ].join("\n"),
    finalStatus === "rejected" ? "warning" : "info",
  )
  void deps
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
