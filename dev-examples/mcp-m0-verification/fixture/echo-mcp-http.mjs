#!/usr/bin/env node
// M0 fixture B：极简 Streamable HTTP MCP server（零依赖 node:http）
// - POST /mcp：JSON-RPC（initialize/tools/list/tools/call），application/json 响应，带 mcp-session-id
// - GET  /mcp：405（不支持 SSE 流，MCP 规范允许）
// - POST /auth-required：恒 401（M0-4 报错路径用）
// 数连接：每次 initialize 计数写入 FIXTURE_HTTP_STATS（JSON：{initializes, sessionIds[]}）
import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.env.FIXTURE_HTTP_PORT || 3927);
const STATS = process.env.FIXTURE_HTTP_STATS;
const sessions = new Set();

const tools = [
  { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "get_time", description: "ISO timestamp", inputSchema: { type: "object", properties: {} } },
];

function callTool(name, args) {
  if (name === "echo") return { content: [{ type: "text", text: String(args?.text ?? "") }] };
  if (name === "get_time") return { content: [{ type: "text", text: new Date().toISOString() }] };
  return { content: [{ type: "text", text: `unknown ${name}` }], isError: true };
}

function bumpStat(patch) {
  if (!STATS) return;
  let cur = { initializes: 0, sessionIds: [] };
  try { cur = JSON.parse(fs.readFileSync(STATS, "utf8")); } catch {}
  cur.initializes += patch.initializes ?? 0;
  if (patch.sessionId) cur.sessionIds.push(patch.sessionId);
  fs.writeFileSync(STATS, JSON.stringify(cur));
}

const server = http.createServer((req, res) => {
  if (req.method === "GET") {
    // OAuth discovery 与 SSE 探测路径：返回 404 JSON（非 405，避免被当成不支持 SSE 的重试信号）
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {    if (req.url === "/auth-required") {
      res.writeHead(401, { "www-authenticate": "Bearer realm=\"m0\"" }).end();
      return;
    }
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    if (!msg.id) {
      // notification（如 notifications/initialized）→ 202 无 body
      res.writeHead(202); res.end();
      return;
    }
    if (msg.method === "initialize") {
      const sid = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      sessions.add(sid);
      bumpStat({ initializes: 1, sessionId: sid });
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": sid });
      res.end(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "m0-http-fixture", version: "1.0.0" },
        },
      }));
    } else if (msg.method === "tools/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools } }));
    } else if (msg.method === "tools/call") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: callTool(msg.params?.name, msg.params?.arguments) }));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
    }
  });
});

let currentPort = PORT;
server.on("error", (e) => {
  const code = e?.code;
  if ((code === "EACCES" || code === "EADDRINUSE") && currentPort < PORT + 40) {
    currentPort += 1;
    process.stderr.write(`[http-fixture] port blocked (${code}), retrying ${currentPort}\n`);
    server.close();
    server.listen({ port: currentPort, host: "127.0.0.1" });
    return;
  }
  process.stderr.write(`[http-fixture] fatal ${code}\n`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`[http-fixture] listening pid=${process.pid} port=${currentPort}\n`);
  const ready = process.env.FIXTURE_HTTP_READY;
  if (ready) fs.writeFileSync(ready, `${process.pid}:${currentPort}`);
});
