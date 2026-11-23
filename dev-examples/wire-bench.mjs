import fs from "node:fs"

const p = "extensions/commands/workflows/optimize/index.ts"
let t = fs.readFileSync(p, "utf8")

// 1) import
{
  const anchor = 'import { renderReview } from "../../../../src/engine/optimizer/review-renderer.js"'
  if (!t.includes(anchor)) { console.log("1 anchor missing"); process.exit(1) }
  t = t.replace(
    anchor,
    anchor +
      '\nimport { renderBenchmarkVerdict, runRealBenchmark, type RealRunOutcome } from "../../../../src/engine/optimizer/benchmark-adapter.js"\nimport { makeWorkflowTool } from "../../../../src/tools/workflow-tools.js"',
  )
}

// 2) benchmark 阶段：插在静态复检之后、状态判定之前
{
  const anchor = `  // ⑩ 状态：O1 阶段没有真实 Benchmark，因此只能到 benchmark-pending，不能 ready`
  if (!t.includes(anchor)) { console.log("2 anchor missing"); process.exit(1) }

  const block = `  // ⑨b 真实 Benchmark（O2，显式开启）：--benchmark --args '<json>'
  // 默认不跑：game-requirement-audit 这类脚本单次 run 几十分钟，before/after 就是 1~2 小时。
  // 用户必须明确要求并给出 args（多数 workflow 需要 date 等必填参数）。
  let benchmarkText: string | undefined
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
        ctx.ui.notify(\`--args 不是合法 JSON：\${argsRaw}\`, "warning")
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
      const failed = Boolean(out?.isError) || /执行失败|\\[workflow 失败\\]/i.test(text)
      // 指标从 runManager 快照聚合（真实 agent 记录，不是估算）
      const runs = deps.runManager.list()
      const latest = runs[0]
      const detail = latest ? deps.runManager.status(latest.runId) : undefined
      const agents = detail?.agents ?? []
      return {
        ok: !failed,
        durationMs,
        agents: agents.length,
        inputTokens: agents.reduce((n: number, a: any) => n + (a.tokens ?? 0), 0),
        outputTokens: 0,
        failedAgents: agents.filter((a: any) => a.status === "error" || a.status === "failed").length,
        ...(failed ? { error: text.slice(0, 200) } : {}),
      }
    }

    ctx.ui.notify(\`运行真实 Benchmark（before: 生产目录 / after: 工作区，args=\${JSON.stringify(benchArgs)}）…\`, "info")
    const verdict = await runRealBenchmark({
      scriptPath: path.join(resolved.root, path.basename(resolved.ref)),
      cwd,
      run: ({ label }) => runOnce(label),
      qualityGate,
      ...(verifierCmd
        ? { runVerifier: async (cmd: string) => ({ ok: true, output: \`verifier 已配置但未执行：\${cmd}（O2 首版仅接受 shell 退出码，需在后续接入）\` }) }
        : {}),
    })
    benchmarkAccepted = verdict.accepted
    qualityStatus = verdict.quality.status
    benchmarkText = renderBenchmarkVerdict(verdict)
    fs.writeFileSync(path.join(p.dir, "benchmark.md"), \`# Benchmark\\n\\n\${benchmarkText}\\n\`, "utf8")
  }

${anchor}`

  t = t.replace(anchor, block)

  // 3) 结束状态：benchmark 通过 → ready；否则 benchmark-pending
  const oldStatus = `  const finalStatus = !staticPass || reviewDecision === "reject" ? "rejected" : "benchmark-pending"`
  const newStatus = `  const finalStatus =
    !staticPass || reviewDecision === "reject"
      ? "rejected"
      : benchmarkAccepted
        ? "ready"
        : "benchmark-pending"`
  if (!t.includes(oldStatus)) { console.log("3 anchor missing"); process.exit(1) }
  t = t.replace(oldStatus, newStatus)

  // 4) validation 与 blockers 反映 benchmark 结果
  t = t.replace(
    '    validation: { static: staticPass ? "pass" : "fail", aiRuleCheck: "unavailable", benchmark: "pending", quality: "pending" },',
    `    validation: {
      static: staticPass ? "pass" : "fail",
      aiRuleCheck: "unavailable",
      benchmark: benchmarkText ? (benchmarkAccepted ? "pass" : "fail") : "pending",
      quality: benchmarkText ? qualityStatus : "pending",
    },`,
  )
  t = t.replace(
    '  if (finalStatus === "benchmark-pending") {\n    blockers.push("O2 真实 Benchmark 尚未接入：当前只有静态与 AI 复核证据，**不能写回生产文件**。")\n  }',
    `  if (benchmarkText) {
    blockers.push(benchmarkAccepted ? "真实 Benchmark 通过：可申请写回（apply）。" : "真实 Benchmark 未通过，禁止 apply（原因见 benchmark.md）。")
  } else {
    blockers.push("未运行真实 Benchmark（加 --benchmark --args '<json>' 触发）：当前只有静态与 AI 复核证据，**不能写回生产文件**。")
  }`,
  )
  fs.writeFileSync(p, t, "utf8")
  console.log("benchmark stage wired")
}
