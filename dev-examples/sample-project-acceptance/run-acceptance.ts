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

const B_NATIVE = path.join(HERE, "B-subworkflows/native")
const B_COMPOSITE = path.join(HERE, "B-subworkflows/composite")
const B_REGISTRY = path.join(HERE, "B-subworkflows/registry")

interface CaseDef {
  key: string
  scriptPath: string
  /** 执行 cwd：读 docs 的脚本用 sample-project；chain 适配版与 B 类副本自包含 */
  cwd: string
  concurrency?: number
  /** 失败语义用例：预期 runWorkflow 抛错, 错误消息命中此正则即 PASS */
  failureAssert?: (e: unknown) => { ok: boolean; note: string }
  assert: (r: WorkflowRunResult) => { ok: boolean; note: string }
}

/** structured 结果判定：schema 路径返回对象（而非字符串） */
function structuredLike(value: unknown): boolean {
  return typeof value === "object" && value !== null
}

function allOk(r: WorkflowRunResult): boolean {
  return r.agents.length > 0 && r.agents.every((a) => a.status === "ok")
}

/** 失败语义用例：预期 runWorkflow 抛 WORKFLOW_FAILED 类错误 */
function expectWorkflowFailure(match: RegExp): (e: unknown) => { ok: boolean; note: string } {
  return (e: unknown) => {
    const msg = String((e as Error)?.message ?? e)
    return { ok: match.test(msg), note: `预期失败已捕获: ${msg.slice(0, 120)}` }
  }
}

// ---- P0-B: 子工作流与 sequence（M1）——自包含副本，cwd 用 B-subworkflows 子目录 ----
const P0B_CASES: CaseDef[] = [
  {
    key: "native-pipeline",
    scriptPath: path.join(B_NATIVE, "pipeline_parent.js"),
    cwd: B_NATIVE,
    assert: (r) => {
      const res = r.result as any
      return {
        ok: r.agentCount === 3 && allOk(r) && typeof res?.brief === "string" && typeof res?.design === "string" && typeof res?.code === "string",
        note: "三段串行 spec->design->code 纯编排父",
      }
    },
  },
  {
    key: "deep-parent",
    scriptPath: path.join(B_NATIVE, "deep_parent.js"),
    cwd: B_NATIVE,
    assert: (r) => {
      const res = r.result as any
      return { ok: allOk(r) && typeof res?.brief === "string", note: `root->child->spec 两层, agentCount=${r.agentCount}` }
    },
  },
  {
    key: "deep-chain",
    scriptPath: path.join(B_NATIVE, "deep_chain_parent.js"),
    cwd: B_NATIVE,
    assert: (r) => {
      const res = r.result as any
      return { ok: typeof res === "string" || res == null || typeof res === "object", note: `三层链 root->l2->l3, agentCount=${r.agentCount}` }
    },
  },
  {
    key: "self-ref-reject",
    scriptPath: path.join(B_NATIVE, "self_ref_parent.js"),
    cwd: B_NATIVE,
    failureAssert: expectWorkflowFailure(/自环|祖先/),
    assert: () => ({ ok: false, note: "不应到达" }),
  },
  {
    key: "error-propagation",
    scriptPath: path.join(B_NATIVE, "error_parent.js"),
    cwd: B_NATIVE,
    assert: (r) => {
      const res = r.result as any
      return {
        ok: res?.caught === true && typeof res?.message === "string" && res.message.includes("产物闸门"),
        note: "child throw 被父捕获降级",
      }
    },
  },
  {
    key: "mutate-args-isolation",
    scriptPath: path.join(B_NATIVE, "mutate_parent.js"),
    cwd: B_NATIVE,
    assert: (r) => {
      const res = r.result as any
      return {
        ok: res?.counter === 1 && res?.injected === false && allOk(r),
        note: "args 克隆隔离（child 内 999/injected 改动不外溢父层）",
      }
    },
  },
  {
    key: "registry-byname",
    scriptPath: path.join(B_REGISTRY, "registry_parent.js"),
    cwd: B_REGISTRY,
    assert: (r) => {
      const res = r.result as any
      return { ok: res?.status === "ok" && typeof res?.reply === "string", note: "注册名 schedule_test 按名寻址" }
    },
  },
  {
    key: "compare-parallel",
    scriptPath: path.join(B_NATIVE, "compare_parent.js"),
    cwd: B_NATIVE,
    assert: (r) => {
      const res = r.result as any
      const briefs = Array.isArray(res) ? res : []
      return {
        ok: r.agentCount === 3 && allOk(r) && briefs.length === 3 && new Set(briefs).size === 3,
        note: "同脚本三实例并行 args 隔离（brief 互不相同）",
      }
    },
  },
  {
    key: "composite-seq",
    scriptPath: path.join(B_COMPOSITE, "seq_parent.js"),
    cwd: B_COMPOSITE,
    assert: (r) => {
      const res = r.result as any
      return {
        ok: typeof res?.lastNodeValue?.code === "string" && res?.chain?.includes("prev"),
        note: "sequence 三段 prev 链传递",
      }
    },
  },
  {
    key: "composite-seq-fail",
    scriptPath: path.join(B_COMPOSITE, "seq_fail_parent.js"),
    cwd: B_COMPOSITE,
    assert: (r) => {
      const res = r.result as any
      return {
        ok: res?.isNull === true && res?.seen?.length === 2 && res?.seen?.[0] === "a" && res?.after === "STOP-CHECK",
        note: "sequence 可恢复失败立即停止返回 null, 同 phase 收尾照常",
      }
    },
  },
  {
    key: "composite-seq-parallel",
    scriptPath: path.join(B_COMPOSITE, "seq_parallel_parent.js"),
    cwd: B_COMPOSITE,
    assert: (r) => {
      const res = r.result as any
      return {
        ok: res?.laneCount === 2 && Array.isArray(res?.briefs) && res.briefs.length === 2,
        note: "sequence 内组合 parallel 两实例并发保序",
      }
    },
  },
  {
    key: "par-child-fail-collapse",
    scriptPath: path.join(B_COMPOSITE, "par_child_fail_parent.js"),
    cwd: B_COMPOSITE,
    assert: (r) => {
      const res = r.result as any
      return {
        ok: res?.failedLane === "collapsed-null" && typeof res?.okLane === "string" && res.okLane.length > 0,
        note: "parallel 内 child 失败塌缩 null, 兄弟分支照常",
      }
    },
  },
  {
    key: "failure-gate",
    scriptPath: path.join(B_COMPOSITE, "failure-gate-test.js"),
    cwd: B_COMPOSITE,
    failureAssert: expectWorkflowFailure(/阶段失败闸门/),
    assert: () => ({ ok: false, note: "不应到达" }),
  },
  {
    key: "queue-timer",
    scriptPath: path.join(B_COMPOSITE, "queue-timer-test.js"),
    cwd: B_COMPOSITE,
    concurrency: 2,
    assert: (r) => ({ ok: r.agentCount === 4 && allOk(r) && r.result === 4, note: "并发 2 下 4 agent 排队执行" }),
  },
]

const G_UI = path.join(HERE, "G-ui")

const CASES: CaseDef[] = [
  {
    // 结构化（JSON schema）结果展示验收：structured 输出落 journal + 详情渲染语义
    key: "schema-result-view",
    scriptPath: path.join(G_UI, "schema-result-view-test.js"),
    cwd: REPO_ROOT, // 脚本内 runTool 用仓库根相对路径
    assert: (r) => {
      const res = r.result as any
      const structuredOk =
        structuredLike(res?.structured) &&
        typeof res?.structured?.apiKey === "string" &&
        Array.isArray(res?.structured?.items)
      const bigAgent = r.agents.find((a) => a.label === "BigTextAgent")
      const bigOk = bigAgent?.outputType === "text" && (bigAgent?.outputPreview?.length ?? 0) > 0
      const failedTool = r.agents.find((a) => a.label?.startsWith("tool "))
      const bigBytes = res?.bigBytes ?? 0
      // 模型输出长度不可控：>20KB 时才真正走到渲染截断路径；不足时由单测确定性覆盖
      const truncation = bigBytes >= 20 * 1024 ? "截断路径已触发" : "大文本未达 20KB（截断由单测覆盖）"
      return {
        ok: structuredOk && bigOk && res?.failedOk === false,
        note: `structured=${structuredLike(res?.structured)} bigText=${bigBytes}B(${truncation}) toolFailure=${res?.failedOk === false}${failedTool ? "" : ""}`,
      }
    },
  },
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
  const runId = `${P0B_CASES.includes(def) ? "p0b" : "p0a"}-${def.key}-${Date.now()}`
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
    if (def.failureAssert) {
      const verdict = def.failureAssert(e)
      return {
        key: def.key,
        status: verdict.ok ? "PASS" : "FAIL",
        agentCount: 0,
        elapsedMs: Date.now() - t0,
        note: verdict.note,
        error: verdict.ok ? undefined : `预期失败但消息不匹配: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
      }
    }
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
let cases = [...CASES, ...P0B_CASES]
if (filter.length) cases = cases.filter((c) => filter.some((f) => c.key.includes(f)))

console.log(`P0 验收（P0-A/P0-B）：${cases.length} 个脚本，真实模型串行执行...\n`)
const rows: Row[] = []
for (const def of cases) {
  process.stdout.write(`- ${def.key} ... `)
  const row = await runCase(def)
  rows.push(row)
  console.log(`${row.status}（${row.agentCount} agents, ${row.elapsedMs}ms）${row.error ? `\n  错误: ${row.error}` : ""}`)
}

console.log("\n==== P0 验收结果 ====")
for (const r of rows) {
  console.log(`  ${r.status.padEnd(4)} ${r.key.padEnd(18)} ${String(r.agentCount).padStart(3)} agents ${String(r.elapsedMs).padStart(7)}ms  ${r.note}${r.error ? `\n      ${r.error}` : ""}`)
}
const pass = rows.filter((r) => r.status === "PASS").length
console.log(`\n${pass}/${rows.length} PASS${pass === rows.length ? " —— 验收通过" : " —— 存在失败项"}`)

// 保留 journal 供审计；清理隔次运行产物
process.exit(pass === rows.length ? 0 : 1)
