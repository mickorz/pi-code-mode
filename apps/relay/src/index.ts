#!/usr/bin/env node
/**
 * pi-code-mode relay：跨进程 run 观测中继（HTTP + SSE）。
 *
 *   pi-code-mode-relay [--port 7878] [--cwd <项目根>]
 *
 * 为什么不是 PiBot 那种跨设备消息中继：我们没有「远程会话」业务面。
 * 这里的中继解决的是本项目真实问题——CLI / runner / pi 宿主可能是不相干的进程，
 * 要有一个统一的地方看正在跑的 run：直接 tail `.pi/workflows/journal/*.json` 推送。
 *
 * 端点：
 *   GET /                 内置实时页面（浏览器打开即用）
 *   GET /runs             全部 run 的落盘摘要（JSON）
 *   GET /events?runId=    SSE：该 run 的 journal 变化（缺省全部 run）
 *   GET /health           存活探针
 */
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { RUN_JOURNAL_DIR } from "../../../packages/manager/src/run-journal.js"

interface RelayOptions {
  port: number
  cwd: string
}

function parse(argv: string[]): RelayOptions {
  const options: RelayOptions = { port: 7878, cwd: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === "--help" || token === "-h") {
      console.log("pi-code-mode-relay [--port 7878] [--cwd <项目根>]")
      process.exit(0)
    } else if (token === "--port") {
      options.port = Number(argv[++i])
    } else if (token === "--cwd") {
      options.cwd = path.resolve(argv[++i] ?? ".")
    } else {
      throw new Error(`未知选项: ${token}`)
    }
  }
  return options
}

/** 读单个 run 的 journal 文件（损坏/半写返回 null，下一轮再读） */
function readRunFile(file: string): { runId: string; metadata?: unknown; observability?: unknown } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      metadata?: unknown
      observability?: unknown
    }
    return { runId: path.basename(file, ".json"), metadata: parsed.metadata, observability: parsed.observability }
  } catch {
    return null
  }
}

function listRuns(dir: string): Array<{ runId: string; metadata?: unknown; observability?: unknown }> {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .map((name) => readRunFile(path.join(dir, name)))
    .filter((run): run is NonNullable<typeof run> => run !== null)
    .sort((a, b) => {
      const at = (a.metadata as { startedAt?: number } | undefined)?.startedAt ?? 0
      const bt = (b.metadata as { startedAt?: number } | undefined)?.startedAt ?? 0
      return bt - at
    })
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>pi-code-mode runs</title>
<style>
 body{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;background:#0f1115;color:#c9d1d9}
 header{padding:10px 16px;border-bottom:1px solid #21262d;display:flex;gap:12px;align-items:center}
 main{display:grid;grid-template-columns:280px 1fr;min-height:calc(100vh - 42px)}
 #runs{border-right:1px solid #21262d;overflow:auto}
 .run{padding:8px 12px;border-bottom:1px solid #161b22;cursor:pointer}
 .run:hover{background:#161b22}.run.active{background:#1f2937}
 .id{color:#58a6ff;font-size:12px}.meta{color:#8b949e;font-size:11px}
 #events{overflow:auto;padding:12px}
 .ev{padding:2px 0;border-bottom:1px solid #161b22;white-space:pre-wrap;word-break:break-all}
 .ok{color:#3fb950}.failed{color:#f85149}.running{color:#d29922}
</style></head><body>
<header><b>pi-code-mode</b><span id="status">连接中…</span><span id="dir"></span></header>
<main><div id="runs"></div><div id="events"></div></main>
<script>
let es=null,current=null;
const runsEl=document.getElementById('runs'),evEl=document.getElementById('events');
const draw=(runs)=>{runsEl.innerHTML=runs.map(r=>{
  const m=r.metadata||{};const cls=m.status==='ok'?'ok':m.status==='failed'?'failed':'running';
  return '<div class="run'+(r.runId===current?' active':'')+'" data-id="'+r.runId+'">'
   +'<div class="id">'+r.runId+'</div>'
   +'<div class="meta '+cls+'">'+(m.workflowId||m.workflowName||'?')+' · '+(m.status||'running')
   +' · '+((r.observability&&r.observability.agents)?r.observability.agents.length:0)+' agents</div></div>';}).join('');
 runsEl.querySelectorAll('.run').forEach(el=>el.onclick=()=>attach(el.dataset.id));};
const attach=(runId)=>{current=runId;evEl.innerHTML='';if(es)es.close();
 es=new EventSource('/events'+(runId?'?runId='+encodeURIComponent(runId):''));
 es.onopen=()=>document.getElementById('status').textContent='已连接 '+(runId||'全部 run');
 es.onmessage=(e)=>{const div=document.createElement('div');div.className='ev';div.textContent=e.data;evEl.appendChild(div);
  evEl.scrollTop=evEl.scrollHeight;};
 es.onerror=()=>{document.getElementById('status').textContent='连接断开，重试中…';};
 fetchRuns();};
const fetchRuns=async()=>{const r=await fetch('/runs');draw(await r.json());};
fetchRuns();setInterval(fetchRuns,3000);
</script></body></html>`

export function createRelayServer(options: RelayOptions): http.Server {
  const journalDir = path.join(options.cwd, RUN_JOURNAL_DIR)
  const clients = new Set<{ res: http.ServerResponse; runId?: string }>()

  const broadcast = (runId: string, snapshot: unknown) => {
    const data = `data: ${JSON.stringify({ runId, snapshot })}\n\n`
    for (const client of clients) {
      if (!client.runId || client.runId === runId) client.res.write(data)
    }
  }

  // 轮询而非 fs.watch：跨平台差异小，且 journal 是终态快照写入（低频）
  let lastSeen = new Map<string, number>()
  const timer = setInterval(() => {
    if (!fs.existsSync(journalDir)) return
    const next = new Map<string, number>()
    for (const name of fs.readdirSync(journalDir)) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue
      const file = path.join(journalDir, name)
      const mtime = fs.statSync(file).mtimeMs
      next.set(name, mtime)
      if (lastSeen.get(name) === mtime) continue
      const snapshot = readRunFile(file)
      if (snapshot) broadcast(snapshot.runId, snapshot)
    }
    lastSeen = next
  }, 500)
  timer.unref()

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }))
      return
    }
    if (url.pathname === "/runs") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
      res.end(JSON.stringify(listRuns(journalDir)))
      return
    }
    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      const client = { res, runId: url.searchParams.get("runId") ?? undefined }
      clients.add(client)
      res.write(`: connected ${new Date().toISOString()}\n\n`)
      req.on("close", () => clients.delete(client))
      return
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE)
      return
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found")
  })

  server.on("close", () => {
    clearInterval(timer)
    for (const client of clients) client.res.end()
    clients.clear()
  })
  return server
}

function main(): void {
  const options = parse(process.argv.slice(2))
  const server = createRelayServer(options)
  server.listen(options.port, () => {
    console.error(`[relay] http://127.0.0.1:${options.port}  journal=${path.join(options.cwd, RUN_JOURNAL_DIR)}`)
  })
}

// 直接执行时才监听端口（被 tests 导入时只拿 createRelayServer）
if (process.argv[1] && path.resolve(process.argv[1]).includes(path.join("apps", "relay"))) main()
