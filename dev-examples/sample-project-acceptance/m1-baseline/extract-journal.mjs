// M1-T0 执行数据还原（Windows 路径安全版）
import fs from "node:fs"
import path from "node:path"
const journalDir = process.argv[2].replace(/\//g, path.sep)
const outFile = process.argv[3]
const runs = []
for (const f of fs.readdirSync(journalDir)) {
  if (!f.endsWith(".json")) continue
  try {
    const d = JSON.parse(fs.readFileSync(path.join(journalDir, f), "utf8"))
    const entries = Object.entries(d.entries ?? {})
    let agents = 0, inputTokens = 0, outputTokens = 0, failed = 0, durations = [], perAgent = []
    for (const [k, e] of entries) {
      if (e.hash) agents++
      const u = e.usage
      if (u) { inputTokens += u.input ?? 0; outputTokens += u.output ?? 0 }
      const exFailed = e.executions?.some((x) => x.status === "failed")
      if (exFailed) failed++
      if (typeof e.durationMs === "number") { durations.push(e.durationMs); perAgent.push({ label: e.label, durationMs: e.durationMs, inputTokens: u?.input ?? 0 }) }
    }
    durations.sort((a, b) => a - b)
    const p = (q) => durations.length ? Math.round(durations[Math.floor(durations.length * q)]) : 0
    runs.push({ file: f, runId: d.runId, entries: entries.length, agents,
      inputTokens, outputTokens, failed,
      durationP50Min: +(p(0.5) / 60000).toFixed(1), durationP90Min: +(p(0.9) / 60000).toFixed(1), durationMaxMin: +((durations.at(-1) ?? 0) / 60000).toFixed(1),
      slowestAgent: perAgent.sort((x, y) => y.durationMs - x.durationMs)[0] })
  } catch (e) { runs.push({ file: f, error: String(e).slice(0, 120) }) }
}
runs.sort((a, b) => (b.agents ?? 0) - (a.agents ?? 0))
fs.writeFileSync(outFile, JSON.stringify({ totalRuns: runs.length, runs }, null, 2))
console.log(`提取 ${runs.length} 个 run。Top 6（按 agent 数）：`)
for (const r of runs.slice(0, 6)) {
  console.log(`  ${r.runId ?? r.file} agents=${r.agents} P50=${r.durationP50Min}min max=${r.durationMaxMin}min failed=${r.failed} 最慢Agent="${r.slowestAgent?.label?.slice(0, 24)}"${r.slowestAgent ? ` ${r.slowestAgent.durationMs / 60000 | 0}min` : ""}`)
}
