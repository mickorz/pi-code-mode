#!/usr/bin/env node
// M0 fixture：极简 stdio MCP server（零依赖，换行分隔 JSON-RPC 2.0）
// 提供 4 个工具：echo / get_time / add / slow
// 启动时把 "pid=<PID>" 追加写入 FIXTURE_PID_LOG（M0-4 数进程用），日志走 stderr（MCP 规范）

import fs from "node:fs";
import readline from "node:readline";

const pidLog = process.env.FIXTURE_PID_LOG;
if (pidLog) {
  try {
    fs.appendFileSync(pidLog, `pid=${process.pid}\n`);
  } catch (e) {
    process.stderr.write(`[fixture] pid log failed: ${e.message}\n`);
  }
}
process.stderr.write(`[fixture] started pid=${process.pid}\n`);

const tools = [
  {
    name: "echo",
    description: "Echo back the given text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo" } },
      required: ["text"],
    },
  },
  {
    name: "get_time",
    description: "Return the current ISO timestamp",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add",
    description: "Add two numbers",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
  {
    name: "slow",
    description: "Sleep for ms then return done",
    inputSchema: {
      type: "object",
      properties: { ms: { type: "number", description: "Sleep duration ms" } },
      required: ["ms"],
    },
  },
];

function callTool(name, args) {
  switch (name) {
    case "echo":
      return { content: [{ type: "text", text: String(args?.text ?? "") }] };
    case "get_time":
      return { content: [{ type: "text", text: new Date().toISOString() }] };
    case "add":
      return { content: [{ type: "text", text: String(Number(args?.a) + Number(args?.b)) }] };
    case "slow": {
      const ms = Math.max(0, Number(args?.ms) || 0);
      const end = Date.now() + ms;
      // 同步忙等在单线程 server 会阻塞并发请求，改用 Atomics.wait 让事件循环可用
      while (Date.now() < end) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(end - Date.now(), 50));
      }
      return { content: [{ type: "text", text: `done after ${ms}ms` }] };
    }
    default:
      return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("close", () => {
  process.stderr.write(`[fixture] stdin closed, exiting pid=${process.pid}\n`);
  process.exit(0);
});
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    process.stderr.write(`[fixture] bad json line\n`);
    return;
  }
  if (msg.method === "initialize") {
    send(msg.id, {
      protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "m0-echo-fixture", version: "1.0.0" },
    });
  } else if (msg.method === "tools/list") {
    send(msg.id, { tools });
  } else if (msg.method === "tools/call") {
    if (process.env.FIXTURE_CALL_LOG) {
      try {
        fs.appendFileSync(process.env.FIXTURE_CALL_LOG, `${msg.params?.name}\n`);
      } catch {}
    }
    const result = callTool(msg.params?.name, msg.params?.arguments);
    send(msg.id, result);
  } else if (msg.id !== undefined) {
    send(msg.id, {});
  }
  // notifications（initialized 等）无需响应
});

function send(id, result) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n",
  );
}
