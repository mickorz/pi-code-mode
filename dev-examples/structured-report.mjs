#!/usr/bin/env node
/**
 * 把 writeOptimizeReport 从「markdown 塞进 <pre>」改为「结构化数据直出 HTML」
 *
 * 问题：之前把 review.md 原文放进 <pre>，浏览器里显示的是 ## 标题、| 表格 |、```diff 围栏，
 * 全是原始标记文本，不是渲染后的报告。
 *
 * 改为：直接用 session/patch/review/diffs 等结构化数据渲染卡片 + 表格 + 带颜色的 diff。
 * 比写 markdown 解析器更少代码，也不会解析错。
 */
import fs from "node:fs"

const p = "extensions/commands/workflows/optimize/index.ts"
let t = fs.readFileSync(p, "utf8")

// 1) 替换调用处：传结构化数据
const oldCall = `    reportPath = writeOptimizeReport(
      p.dir,
      [
        finalStatus === "rejected" ? \`[候选被拒绝] \${id}\` : \`[优化候选待验证] \${id}\`,
        \`目标：\${ref}\`,
        \`问题簇：\${selected.map((c) => c.ruleId).join(", ")}\`,
        \`修改：\${files} 个文件 / \${edits} 处补丁\`,
        \`静态：\${before.report.summary.totalFindings} 条 → \${afterFindings} 条\`,
        ...blockers.map((b) => \`- \${b}\`),
      ].join("\\n"),
      reviewMd,
    )`
const newCall = `    reportPath = writeOptimizeReport({
      dir: p.dir,
      id,
      status: finalStatus,
      target: ref,
      clusters: selected.map((c) => ({ ruleId: c.ruleId, count: c.count, severity: c.severity, confidence: c.confidence })),
      files: validation.normalized.files.map((f) => ({ path: f.path, edits: f.edits.length })),
      diffs: diffs.map((d) => ({ path: d.path, diff: d.diff })),
      patchReview,
      findingsBefore: before.report.summary.totalFindings,
      findingsAfter: afterFindings,
      targetResolved,
      blockers,
      timings,
    })`
if (!t.includes(oldCall)) {
  console.log("1 anchor missing")
  process.exit(1)
}
t = t.replace(oldCall, newCall)

// 2) 替换 writeOptimizeReport 实现
const fnStart = t.indexOf("function writeOptimizeReport(")
const fnEnd = t.indexOf("/** 简易 unified diff", fnStart)
if (fnStart < 0 || fnEnd < 0) {
  console.log("2 anchors missing")
  process.exit(1)
}
// 往前吞掉函数上方的 JSDoc
let jsdocStart = fnStart
while (jsdocStart > 0 && !t.slice(jsdocStart - 3, jsdocStart).includes("*/")) jsdocStart--
// 简单处理：从最近的 "/**" 开始
const docStart = t.lastIndexOf("/**", fnStart)

const impl = `/**
 * 生成 optimize 的 HTML 报告（结构化直出，不经 markdown）。
 *
 * 之前把 review.md 原文塞进 <pre>，浏览器里看到的是 ## / | 表格 | / \`\`\`diff 这些原始标记。
 * 这里直接用 session / patch / review / diffs 数据渲染卡片、表格与带颜色的 diff。
 */
function writeOptimizeReport(input: {
  dir: string
  id: string
  status: string
  target: string
  clusters: Array<{ ruleId: string; count: number; severity: string; confidence: number }>
  files: Array<{ path: string; edits: number }>
  diffs: Array<{ path: string; diff: string }>
  patchReview?: PatchReview
  findingsBefore: number
  findingsAfter: number
  targetResolved: boolean
  blockers: string[]
  timings: { staticMs: number; aiMs: number }
}): string {
  const esc = (s: unknown) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")

  const SEV_COLOR: Record<string, string> = { critical: "#DC5148", high: "#E8A044", medium: "#4389D5", low: "#94A3B8" }
  const ok = input.status === "ready" || input.status === "benchmark-pending"

  // diff 着色：+ 绿 / - 红 / @@ 蓝
  const renderDiff = (diff: string) =>
    diff
      .split("\\n")
      .map((line) => {
        const e = esc(line)
        if (line.startsWith("+") && !line.startsWith("+++")) return \`<span class="add">\${e}</span>\`
        if (line.startsWith("-") && !line.startsWith("---")) return \`<span class="del">\${e}</span>\`
        if (line.startsWith("@@")) return \`<span class="hunk">\${e}</span>\`
        if (line.startsWith("---") || line.startsWith("+++")) return \`<span class="file">\${e}</span>\`
        return e
      })
      .join("\\n")

  const clusterRows = input.clusters
    .map(
      (c) =>
        \`<tr><td><code>\${esc(c.ruleId)}</code></td><td><span class="ptag" style="background:\${SEV_COLOR[c.severity] ?? "#94A3B8"}">\${esc(c.severity)}</span></td><td>\${c.count}</td><td>\${c.confidence.toFixed(2)}</td></tr>\`,
    )
    .join("")

  const fileRows = input.files.map((f) => \`<tr><td><code>\${esc(f.path)}</code></td><td>\${f.edits} 处</td></tr>\`).join("")

  const reviewFindings = (input.patchReview?.findings ?? [])
    .map(
      (f) =>
        \`<li><b class="\${f.severity}">\${esc(f.severity)}</b> <code>\${esc(f.file)}</code>：\${esc(f.reason)}\${
          f.evidence ? \`<div class="ev">\${esc(f.evidence.slice(0, 300))}</div>\` : ""
        }</li>\`,
    )
    .join("")

  const html = \`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Optimize 报告 \${esc(input.id)}</title>
<style>
  :root{--bg:#F6F8FB;--card:#fff;--primary:#3478DB;--text:#253247;--muted:#8491A3;--border:#E7ECF2;--radius:12px}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--text);font-family:"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;font-size:14px;line-height:1.6}
  .page{max-width:1200px;margin:0 auto;padding:24px 32px 64px}
  h1{font-size:22px;font-weight:700;margin-bottom:6px}
  .sub{font-size:13px;color:var(--muted);margin-bottom:20px;word-break:break-all}
  .card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:22px;margin-bottom:18px}
  .card h2{font-size:15px;font-weight:600;margin-bottom:14px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;margin-bottom:18px}
  .kpi{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px}
  .kpi .v{font-size:28px;font-weight:700;line-height:1.2}
  .kpi .l{font-size:12.5px;color:var(--muted);margin-top:2px}
  .kpi .v.ok{color:#2F9E5B}.kpi .v.warn{color:#C07A00}.kpi .v.bad{color:#DC5148}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-size:12px;color:var(--muted);font-weight:600;padding:8px 10px;border-bottom:1px solid var(--border)}
  td{padding:9px 10px;border-bottom:1px solid #F0F3F7}
  code{font-family:"SF Mono",Consolas,monospace;font-size:12.5px;background:#EEF1F5;padding:1px 6px;border-radius:4px}
  .ptag{display:inline-block;font-size:11px;font-weight:700;padding:1px 8px;border-radius:4px;color:#fff}
  pre{white-space:pre-wrap;word-break:break-word;font-family:"SF Mono",Consolas,monospace;font-size:12.5px;
      background:#0F172A;color:#E2E8F0;border-radius:8px;padding:14px;margin:8px 0;overflow-x:auto}
  pre .add{color:#4ADE80}pre .del{color:#F87171}pre .hunk{color:#60A5FA}pre .file{color:#94A3B8}
  ul{padding-left:20px}li{margin:5px 0}
  .note{border-left:3px solid var(--primary);background:#F6F9FE;border-radius:0 8px 8px 0;padding:12px 16px;font-size:13px;color:#34455C;margin-bottom:14px}
  .ev{color:var(--muted);font-size:12px;margin-top:3px;white-space:pre-wrap}
  .sev-high{color:#DC5148}.sev-medium{color:#E8A044}.sev-low{color:#8491A3}
  .muted{color:var(--muted)}
</style></head><body><div class="page">
  <h1>Optimize 报告</h1>
  <div class="sub">\${esc(input.id)} · 状态 <b>\${esc(input.status)}</b> · \${esc(input.target)}</div>

  <div class="kpis">
    <div class="kpi"><div class="v \${ok ? "ok" : "warn"}">\${esc(input.status)}</div><div class="l">候选状态</div></div>
    <div class="kpi"><div class="v">\${input.files.length}</div><div class="l">修改文件</div></div>
    <div class="kpi"><div class="v">\${input.files.reduce((n, f) => n + f.edits, 0)}</div><div class="l">补丁处数</div></div>
    <div class="kpi"><div class="v">\${input.findingsBefore} → \${input.findingsAfter}</div><div class="l">静态问题数\${input.targetResolved ? "（目标已解决）" : ""}</div></div>
    <div class="kpi"><div class="v">\${Math.round(input.timings.aiMs / 1000)}s</div><div class="l">AI 复核耗时</div></div>
  </div>

  <div class="note">原文件未做任何修改。改造需通过 <code>optimize apply</code>，此前必须完成真实 Benchmark 与质量门。</div>

  <div class="card"><h2>修改的文件</h2>
    <table><thead><tr><th>文件</th><th>改动</th></tr></thead><tbody>\${fileRows || '<tr><td colspan="2" class="muted">（没有生成补丁）</td></tr>'}</tbody></table>
  </div>

  <div class="card"><h2>问题簇</h2>
    <table><thead><tr><th>规则</th><th>严重度</th><th>处数</th><th>置信度</th></tr></thead><tbody>\${clusterRows}</tbody></table>
  </div>

  \${input.diffs.length ? \`<div class="card"><h2>代码差异</h2>\${input.diffs.map((d) => \`<div class="muted" style="margin:10px 0 4px">\${esc(d.path)}</div><pre>\${renderDiff(d.diff)}</pre>\`).join("")}</div>\` : ""}

  \${
    input.patchReview
      ? \`<div class="card"><h2>补丁审查：\${esc(input.patchReview.decision)}</h2>\${
          reviewFindings ? \`<ul>\${reviewFindings}</ul>\` : '<div class="muted">未发现问题。</div>'
        }</div>\`
      : ""
  }

  <div class="card"><h2>结论</h2><ul>\${input.blockers.map((b) => \`<li>\${esc(b)}</li>\`).join("")}</ul></div>
</div></body></html>\`

  const file = path.join(input.dir, "optimize-report.html")
  fs.writeFileSync(file, html, "utf8")
  return file
}

`
t = t.slice(0, docStart) + impl + t.slice(fnEnd)

fs.writeFileSync(p, t, "utf8")
console.log("writeOptimizeReport rewritten as structured HTML")
