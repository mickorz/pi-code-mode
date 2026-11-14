// P0-A 验收 runner：A-basic 类脚本逐个真实模型执行 + 断言 + 汇总表
// 用法:
//   npx tsx run-acceptance.ts                 # 跑 A-basic 全部（smoke/chain-adapted/multi-tree/concurrency/acceptance）
//   npx tsx run-acceptance.ts smoke chain     # 只跑指定脚本（名称关键词）
//
// 注意：
//   - journal/worktree 产物强制落本仓库 dev-examples/sample-project-acceptance/.journal/，
//     不污染只读 submodule（submodule 只读约定见 thirdparties/REFERENCES.md）
//   - 脚本读 docs/*.mdx 时 cwd 指向 sample-project；chain 适配版自包含，cwd 用 adapted 目录
//   - 原版 chain-root/middle/leaf 依赖"子代理调 workflow 工具"（opencode 模式），pi 版跑 adapted 等价脚本
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PiAgentAdapter } from "../../src/adapter/pi-agent-adapter.js"
import { agentAdapterToRunner } from "../../src/adapter/agent-adapter.js"
import { runWorkflow } from "../../src/engine/runtime/workflow-runtime.js"
import { JournalStore } from "../../src/engine/persistence/journal.js"
import type { WorkflowRunResult } from "../../src/engine/types/index.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "../..")
const SAMPLE_PROJECT = path.resolve(REPO_ROOT, "thirdparties/opencode-dynamic-workflows/examples/sample-project")
const JOURNAL_DIR = path.join(HERE, ".journal")

interface CaseDef {
  key: string
  scriptPath: string
  /** 执行 cwd：读 docs 的脚本用 sample-project；chain 适配版自包含 */
  cwd: string
  concurrency?: number
  assert: (r: WorkflowRunResult) => { ok: boolean; note: string }
}

function allOk(r: WorkflowRunResult): boolean {
  return r.agents.length > 0 && r.agents.every((a) => a.status === "ok")
}

const CASES: CaseDef[] = [
  {
    key: "smoke",
    scriptPath: path.join(HERE, "A-basic/smoke-test.js"),
    cwd: SAMPLE_PROJECT,
    assert: (r) => ({
      ok: r.agentCount === 3 && allOk(r) && Array.isArray((r.result as any)?.results) && (r.result as any).results.length === 2,
      note: "1 发现 + 2 并行",
    }),
  },
  {
    key: "chain-adapted",
    scriptPath: path.join(HERE, "A-basic/adapted/chain-adapted-root.js"),
    cwd: path.join(HERE, "A-basic/adapted"), // 自包含：workflow('./xxx.js') 相对本目录解析
    assert: (r) => {
      const result = r.result as any
      const nestedOk = result?.middle?.leaves?.length === 2 && typeof result?.report === "string" && result.report.length > 0
      const invocations = r.workflows?.length ?? 0 // root 自身 1 + middle 1 + leaf 2 = 3
      return { ok: nestedOk && invocations >= 3 && allOk(r), note: `三层嵌套, workflows invocation=${invocations}` }
    },
  },
  {
    key: "multi-tree-a",
    scriptPath: path.join(HERE, "A-basic/multi-tree-a.js"),
    cwd: SAMPLE_PROJECT,
    assert: (r) => ({
      ok: r.agentCount === 4 && allOk(r) && typeof (r.result as any)?.summary === "string",
      note: "3 并行 + 1 汇总",
    }),
  },
  {
    key: "multi-tree-b",
    scriptPath: path.join(HERE, "A-basic/multi-tree-b.js"),
    cwd: SAMPLE_PROJECT,
    assert: (r) => {
      const result = r.result as any
      return {
        ok: r.agentCount === 4 && allOk(r) && result?.round1?.length === 2 && result?.round2?.length === 2,
        note: "两轮 2 并行",
      }
    },
  },
  {
    key: "concurrency-8",
    scriptPath: path.join(HERE, "A-basic/concurrency-limit-test.js"),
    cwd: SAMPLE_PROJECT,
    concurrency: 8,
    assert: (r) => {
      // 24 探针全 ok；有效并发度 = sum(durationMs)/wall-clock ≈ concurrency（宽松区间 [3,13]）
      const sum = r.agents.reduce((s, a) => s + (a.durationMs ?? 0), 0)
      const effective = Math.round((sum / Math.max(r.durationMs, 1)) * 10) / 10
      const ok = r.agentCount === 24 && allOk(r) && effective >= 3 && effective <= 13
      return { ok, note: `24 探针, 有效并发度≈${effective}（目标 8）` }
    },
  },
  {
    key: "acceptance-10docs",
    scriptPath: path.join(HERE, "A-basic/acceptance-10docs.js"),
    cwd: SAMPLE_PROJECT,
    assert: (r) => {
      const text = typeof r.result === "string" ? r.result : ""
      const docAgents = r.agents.filter((a) => a.label?.includes(".mdx")).length
      // 脚本结构: 1 发现(Scan) + 10 文档分析(docs/*) + 1 汇总(Synthesize) = 12
      return {
        ok: r.agentCount === 12 && docAgents === 10 && allOk(r) && text.length > 200,
        note: `1 发现 + ${docAgents} 文档分析 + 1 汇总, 总览 ${text.length} 字符`,
      }
    },
  },
]

interface Row {
  key: string
  status: "PASS" | "FAIL"
  agentCount: number
  elapsedMs: number
  note: string
  error?: string
}

async function runCase(def: CaseDef): Promise<Row> {
  const script = fs.readFileSync(def.scriptPath, "utf-8")
  const runId = `p0a-${def.key}-${Date.now()}`
  const journal = new JournalStore(def.cwd, JOURNAL_DIR)
  const t0 = Date.now()
  try {
    const outcome = await runWorkflow(script, {
      agent: agentAdapterToRunner(new PiAgentAdapter({ defaultCwd: def.cwd })),
      cwd: def.cwd,
      concurrency: def.concurrency,
      runId,
      onAgentJournal: (entry) => journal.append(runId, entry.key, entry),
    })
    const elapsed = Date.now() - t0
    const verdict = def.assert(outcome)
    return {
      key: def.key,
      status: verdict.ok ? "PASS" : "FAIL",
      agentCount: outcome.agentCount,
      elapsedMs: elapsed,
      note: verdict.note,
      error: verdict.ok ? undefined : `断言未通过: agents=${outcome.agents.map((a) => `${a.label}:${a.status}`).join(",")}`,
    }
  } catch (e) {
    return {
      key: def.key,
      status: "FAIL",
      agentCount: 0,
      elapsedMs: Date.now() - t0,
      note: "执行异常",
      error: String((e as Error)?.message ?? e).slice(0, 300),
    }
  }
}

// ---- main ----
const filter = process.argv.slice(2)
let cases = CASES
if (filter.length) cases = CASES.filter((c) => filter.some((f) => c.key.includes(f)))

console.log(`P0-A 验收：${cases.length} 个脚本，真实模型串行执行...\n`)
const rows: Row[] = []
for (const def of cases) {
  process.stdout.write(`- ${def.key} ... `)
  const row = await runCase(def)
  rows.push(row)
  console.log(`${row.status}（${row.agentCount} agents, ${row.elapsedMs}ms）${row.error ? `\n  错误: ${row.error}` : ""}`)
}

console.log("\n==== P0-A 验收结果 ====")
for (const r of rows) {
  console.log(`  ${r.status.padEnd(4)} ${r.key.padEnd(18)} ${String(r.agentCount).padStart(3)} agents ${String(r.elapsedMs).padStart(7)}ms  ${r.note}${r.error ? `\n      ${r.error}` : ""}`)
}
const pass = rows.filter((r) => r.status === "PASS").length
console.log(`\n${pass}/${rows.length} PASS${pass === rows.length ? " —— P0-A 验收通过" : " —— 存在失败项"}`)

// 保留 journal 供审计；清理隔次运行产物
process.exit(pass === rows.length ? 0 : 1)
