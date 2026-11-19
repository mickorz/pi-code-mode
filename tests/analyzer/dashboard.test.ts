/**
 * Dashboard 契约测试（2026-11-19）
 *
 * 覆盖四类真实缺陷（都曾在真实脚本上验证过）：
 *  1. 子流程 findings 未并入 → 问题列表只剩 1 条、规则页全显示"通过"（与聚合事实矛盾）
 *  2. 合并后未重算 summary.counts → "23 条问题但严重度分布只有 1 条"
 *  3. 同日重复运行覆盖历史 → 必须 -01/-02 递增
 *  4. 平台打开命令构造（Windows 空 title 占位是硬要求）
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  buildDashboardView,
  nextDashboardName,
  renderDashboardHtml,
  validateView,
  writeDashboard,
} from "../../src/engine/analyzer/dashboard/build-dashboard.js"
import { analyzeWorkflowTree } from "../../src/engine/analyzer/tree-analyzer.js"
import { openCommandFor, shouldAutoOpen } from "../../src/utils/open-browser.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wf-dash-"))

/** 入口 + 2 个子流程（子流程各含问题），用于验证合并口径 */
function makeTree(): ReturnType<typeof analyzeWorkflowTree> {
  const dir = tmp()
  const wf = path.join(dir, "audit")
  fs.mkdirSync(wf, { recursive: true })
  fs.writeFileSync(
    path.join(wf, "main.js"),
    `export const meta = { name: 'main' }
const a = await workflow({ scriptPath: './1-a.js' })
const b = await workflow({ scriptPath: './2-b.js' })
return [a, b]`,
  )
  for (const name of ["1-a.js", "2-b.js"]) {
    fs.writeFileSync(
      path.join(wf, name),
      `export const meta = { name: '${name}' }
const x = await agent('读一批文件', { retries: 2 })
const y = await agent('再读一批文件', { retries: 2 })
return x + y`,
    )
  }
  return analyzeWorkflowTree({ entryPath: path.join(wf, "main.js") })
}

test("buildDashboardView：子树 findings 必须并入问题列表", () => {
  const tree = makeTree()
  const report = {
    ...tree.entry,
    subtree: {
      files: tree.aggregate.files,
      callSites: tree.aggregate.callSites,
      totalFindings: tree.aggregate.totalFindings,
      maxRisk: tree.aggregate.maxRisk,
      rules: tree.aggregate.rules,
      subWorkflows: tree.subWorkflows.map((s) => ({
        file: s.file,
        riskScore: s.riskScore,
        callSites: s.callSites,
        totalFindings: s.totalFindings,
        ...(s.topRule ? { topRule: s.topRule } : {}),
        findings: s.findings,
      })),
    },
  } as Parameters<typeof buildDashboardView>[0]

  const view = buildDashboardView(report)
  const entryFindings = report.findings.length
  const subFindings = tree.subWorkflows.reduce((n, s) => n + s.findings.length, 0)

  assert.ok(subFindings > 0, "fixture 必须让子流程产生 finding，否则用例无效")
  assert.equal(view.findings.length, entryFindings + subFindings, "子流程 findings 必须全部并入")
  // 每条并入的都要带来源文件，否则用户不知道该去改哪个文件
  for (const f of view.findings) {
    assert.ok(f.file, `finding ${f.ruleId} 缺少来源文件`)
  }
})

test("buildDashboardView：合并后 severity 计数必须重算", () => {
  const tree = makeTree()
  const report = {
    ...tree.entry,
    subtree: {
      files: tree.aggregate.files,
      callSites: tree.aggregate.callSites,
      totalFindings: tree.aggregate.totalFindings,
      maxRisk: tree.aggregate.maxRisk,
      rules: tree.aggregate.rules,
      subWorkflows: tree.subWorkflows.map((s) => ({
        file: s.file,
        riskScore: s.riskScore,
        callSites: s.callSites,
        totalFindings: s.totalFindings,
        findings: s.findings,
      })),
    },
  } as Parameters<typeof buildDashboardView>[0]

  const view = buildDashboardView(report)
  const counts = Object.values(view.summary.counts).reduce((a, b) => a + b, 0)
  // 曾出现「23 条问题，严重度分布只有 1 条」：counts 忘了重算
  assert.equal(counts, view.findings.length, `counts 合计(${counts}) 必须等于 findings 数(${view.findings.length})`)
  assert.equal(view.summary.totalFindings, view.findings.length)
})

test("buildDashboardView：规则命中数合并子流程（否则规则页显示误报的『通过』）", () => {
  const tree = makeTree()
  const report = {
    ...tree.entry,
    subtree: {
      files: tree.aggregate.files,
      callSites: tree.aggregate.callSites,
      totalFindings: tree.aggregate.totalFindings,
      maxRisk: tree.aggregate.maxRisk,
      rules: { "RETRY-001": 4 },
      subWorkflows: tree.subWorkflows.map((s) => ({
        file: s.file,
        riskScore: s.riskScore,
        callSites: s.callSites,
        totalFindings: s.totalFindings,
        findings: s.findings,
      })),
    },
  } as Parameters<typeof buildDashboardView>[0]

  const view = buildDashboardView(report)
  const retry = view.rules.find((r) => r.id === "RETRY-001")!
  assert.equal(retry.status, "hit", "子流程命中必须在规则页体现为 hit")
  assert.ok(retry.hits >= 4, `hits 应累加子流程命中，实际 ${retry.hits}`)
})

test("validateView：字段缺失/计数不一致必须报错（不产出残缺页面）", () => {
  const tree = makeTree()
  const view = buildDashboardView(tree.entry)

  assert.deepEqual(validateView(view), [], "正常视图不应有错误")

  const noRules = { ...view, rules: [] }
  assert.ok(validateView(noRules).some((e) => e.includes("rules 为空")))

  const badCount = { ...view, summary: { ...view.summary, totalFindings: 999 } }
  assert.ok(validateView(badCount).some((e) => e.includes("不一致")))

  const badStatus = { ...view, rules: [{ ...view.rules[0]!, status: "unknown" as never }] }
  assert.ok(validateView(badStatus).some((e) => e.includes("status 非法")))
})

test("nextDashboardName：同日递增不覆盖历史，跨日重置", () => {
  const dir = tmp()
  const day = new Date("2026-11-19T10:00:00")
  const first = nextDashboardName(dir, "audit", day)
  assert.match(first, /^audit分析-Dashboard-20261119-01\.html$/)

  fs.writeFileSync(path.join(dir, first), "x")
  const second = nextDashboardName(dir, "audit", day)
  assert.match(second, /-02\.html$/, `已有 -01 时应生成 -02，实际 ${second}`)

  const nextDay = nextDashboardName(dir, "audit", new Date("2026-11-20T10:00:00"))
  assert.match(nextDay, /-20261120-01\.html$/, "跨日应重新从 01 开始")
})

test("nextDashboardName：项目名非法字符被清理", () => {
  const dir = tmp()
  const name = nextDashboardName(dir, 'a/b:c*d?"e<f>g|h')
  assert.ok(!/[\\/:*?"<>|]/.test(name), `文件名仍含非法字符：${name}`)
})

test("renderDashboardHtml：注入 JSON 并转义 </script>（防止提前闭合）", () => {
  const tree = makeTree()
  const view = buildDashboardView(tree.entry)
  view.diagnostics = ["含 </script> 的诊断文本"]

  const html = renderDashboardHtml(view)
  assert.ok(html.includes("report-data"), "模板占位符应被替换")
  assert.ok(!html.includes("__REPORT_JSON__"), "占位符必须被替换")
  assert.ok(!/<script[^>]*>[^<]*含 <\/script>/.test(html), "</script> 必须被转义，不得提前闭合")
})

test("writeDashboard：落盘 html+json，同一次分析可覆盖同一路径", () => {
  const outDir = tmp()
  const tree = makeTree()
  const a = writeDashboard({ report: tree.entry, outDir, projectName: "audit", aiEnabled: false })
  assert.ok(fs.existsSync(a.htmlPath), "html 必须落盘")
  assert.ok(fs.existsSync(a.jsonPath), "json 必须落盘")

  const html = fs.readFileSync(a.htmlPath, "utf8")
  assert.ok(html.includes("规则检查"), "模板内容应就位")

  // 覆盖模式：同一次分析的静态→AI 两阶段更新，不应产生 -02
  const b = writeDashboard({ report: tree.entry, outDir, projectName: "audit", aiEnabled: true, overwritePath: a.htmlPath })
  assert.equal(b.htmlPath, a.htmlPath, "覆盖模式必须复用同一路径")
  const files = fs.readdirSync(path.join(outDir, "dashboard")).filter((f) => f.endsWith(".html"))
  assert.equal(files.length, 1, `覆盖模式不应新增文件，实际：${files.join(",")}`)
})

test("openCommandFor：三平台命令构造（Windows 需要空 title 占位）", () => {
  // Windows 不能用 `cmd /c start`：中文路径的 %XX 编码会被当路径去找 → 弹窗「系统找不到文件」
  const win = openCommandFor("C:\\tmp\\a b.html", "win32")
  assert.equal(win.cmd, "explorer", "Windows 应用 explorer 打开绝对路径")
  assert.equal(win.args.length, 1)
  assert.ok(win.args[0]!.endsWith("a b.html"), "应传绝对路径")
  assert.ok(!win.args[0]!.includes("file://"), "不得传 file:// URL（中文路径会变成 %XX 而找不到文件）")

  const mac = openCommandFor("/tmp/a.html", "darwin")
  assert.equal(mac.cmd, "open")
  assert.deepEqual(mac.args, [path.resolve("/tmp/a.html")], "应传绝对路径（不同平台的 resolve 结果不同）")

  const linux = openCommandFor("/tmp/a.html", "linux")
  assert.equal(linux.cmd, "xdg-open")
})

test("shouldAutoOpen：CI 与显式关闭时跳过", () => {
  assert.equal(shouldAutoOpen({ CI: "1" }).open, false)
  assert.equal(shouldAutoOpen({ CI: "true" }).open, false)
  assert.equal(shouldAutoOpen({ PI_NO_BROWSER: "1" }).open, false)
  assert.equal(shouldAutoOpen({}).open, true)
})
