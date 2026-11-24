/**
 * M1-T6 契约测试：workflow_analyze 工具 + CLI 共用同一 Analyzer Core
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { analyzeWorkflow, createWorkflowAnalyzeTool, runAnalyzeCli } from "../../packages/tools/src/workflow-analyze-tool.js"

const FIX = path.join(import.meta.dirname, "fixtures", "atomic")

test("内联源码分析：返回报告与建议", async () => {
  const r = await analyzeWorkflow({ source: "await agent('x')", generatedAt: "2026-11-18T00:00:00.000Z" })
  assert.equal(r.ok, true)
  assert.ok(r.report)
  assert.ok(r.rendered!.includes("sourceHash"))
})

test("scriptPath 分析：文件不存在报错", async () => {
  const r = await analyzeWorkflow({ scriptPath: "no-such-file.js", cwd: os.tmpdir() })
  assert.equal(r.ok, false)
  assert.match(r.error!, /不存在/)
})

test("scriptPath 分析：真实 fixture 文件", async () => {
  const r = await analyzeWorkflow({ scriptPath: path.join(FIX, "repeated-context.js"), generatedAt: "2026-11-18T00:00:00.000Z" })
  assert.equal(r.ok, true)
  assert.ok(r.report!.findings.some((f) => f.ruleId === "INPUT-001"))
})

test("md 格式输出：含 Markdown 标题", async () => {
  const r = await analyzeWorkflow({ source: "await agent('x')", format: "md" })
  assert.match(r.rendered!, /# Workflow Analysis/)
})

test("writeReport：写入 .pi/workflows/reports/", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-wr-"))
  fs.copyFileSync(path.join(FIX, "repeated-context.js"), path.join(dir, "rc.js"))
  const r = await analyzeWorkflow({ scriptPath: "rc.js", cwd: dir, writeReport: true })
  assert.equal(r.ok, true)
  assert.ok(r.reportPath && fs.existsSync(r.reportPath))
  assert.ok(fs.existsSync(path.join(dir, ".pi", "workflows", "reports", "rc.analysis.md")))
})

test("includeSuggestions：注入 plannerAgent 后合并 AI 建议", async () => {
  const aiJson = JSON.stringify({
    analysisSummary: "ok",
    proposals: [
      {
        id: "OPT-AI-1",
        title: "AI 建议：提取公共上下文",
        severity: "high",
        target: { startLine: 2, endLine: 4 },
        problem: "重复注入",
        proposal: { type: "input-reduction", action: "抽取公共引用" },
        dependencyAnalysis: "三次调用只读，可安全共享",
        expectedImpact: { note: "待 Benchmark 验证" },
        qualityRisk: "high",
        validation: ["证据可读", "覆盖率不降"],
      },
    ],
  })
  const r = await analyzeWorkflow({
    source: fs.readFileSync(path.join(FIX, "repeated-context.js"), "utf8"),
    includeSuggestions: true,
    plannerAgent: async () => aiJson,
  })
  assert.equal(r.ok, true)
  assert.ok(r.recommendations!.some((x) => x.id === "OPT-AI-1"))
})

test("includeSuggestions：plannerAgent 抛错不阻断静态分析", async () => {
  const r = await analyzeWorkflow({
    source: "await agent('x')",
    includeSuggestions: true,
    plannerAgent: async () => {
      throw new Error("model down")
    },
  })
  assert.equal(r.ok, true)
  assert.ok(r.report!.diagnostics.some((d) => /AI 建议调用失败/.test(d)))
})

test("Pi 工具：execute 返回摘要 + 报告正文", async () => {
  const tool = createWorkflowAnalyzeTool({ cwd: FIX })
  const out: any = await tool.execute("id", { scriptPath: "repeated-context.js" })
  assert.equal(out.isError, undefined)
  assert.match(out.content[0].text, /风险分/)
  assert.match(out.content[0].text, /sourceHash/)
})

test("Pi 工具：错误路径返回 isError", async () => {
  const tool = createWorkflowAnalyzeTool({ cwd: os.tmpdir() })
  const out: any = await tool.execute("id", { scriptPath: "missing.js" })
  assert.equal(out.isError, true)
})

test("CLI 与工具同一 Core：同一输入输出一致", async () => {
  const src = fs.readFileSync(path.join(FIX, "repeated-context.js"), "utf8")
  const viaCore = await analyzeWorkflow({ source: src, generatedAt: "2026-11-18T00:00:00.000Z" })
  const tool = createWorkflowAnalyzeTool({ cwd: FIX })
  const viaTool: any = await tool.execute("id", { scriptPath: "repeated-context.js", format: "json" })
  // 工具输出正文应包含 Core 渲染的字段
  assert.match(viaTool.content[0].text, new RegExp(viaCore.report!.sourceHash.slice(0, 20)))
})

test("CLI：无参数返回用法码 2", async () => {
  const code = await runAnalyzeCli([])
  assert.equal(code, 2)
})

test("CLI：分析 fixture 成功返回 0", async () => {
  const code = await runAnalyzeCli([path.join(FIX, "serial-dependent.js"), "--json"])
  assert.equal(code, 0)
})
