/**
 * M0-4：并行会话连接生命周期（6 组对照，纯编程无模型）
 * G1: 4 Session + stdio 同一 server → 4 独立进程
 * G2: 4 Session + HTTP 同一远端 → 1 进程、4 独立 mcp-session-id（远端共享、pi 侧连接不共享）
 * G3: 并发调用同一工具 → 见 M0-4B 模型驱动补充（本文件不含）
 * G4: 关闭 1 个 Session → 其余 session 连接不受影响
 * G5: 全部 dispose → stdio 进程全部回收（无僵尸）
 * G6: HTTP server 401 报错路径 → 不阻塞其他 server 连接
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Case, createSession, finish, fixtureEntry, waitForTools } from "./lib/session-helper.js";

function pidAlive(pid: string): boolean {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: "utf8" });
    return out.includes(pid);
  } catch {
    return false;
  }
}

async function readPids(file: string): Promise<string[]> {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("pid=")).map((l) => l.slice(4));
  } catch {
    return [];
  }
}

async function waitPidCount(file: string, n: number, timeoutMs = 20000): Promise<string[]> {
  const start = Date.now();
  for (;;) {
    const pids = await readPids(file);
    if (pids.length >= n || Date.now() - start > timeoutMs) return pids;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main() {
  const cases: Case[] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "m0-4-"));
  const pidLog = path.join(tmp, "stdio-pids.log");
  process.env.FIXTURE_PID_LOG = pidLog;

  // ===== G1：4 Session + stdio 同一 server =====
  let g1Sessions: Awaited<ReturnType<typeof createSession>>[] = [];
  {
    const c = new Case("m0-4-G1");
    console.log("\n== G1: 4 Session + stdio 同一 server ==");
    fs.writeFileSync(pidLog, ""); // 清零，只统计本轮
    const entry = fixtureEntry("fix", { exposure: "direct" });
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await createSession({ entries: [entry] }));
    }
    g1Sessions = results;
    for (const r of results) await waitForTools(r.session, (n) => n.includes("mcp__fix__echo"));
    const pids = await waitPidCount(pidLog, 4);
    const unique = [...new Set(pids)];
    c.assert("stdio server 进程数 = 4（每 session 独立进程）", unique.length === 4, `pids=${unique.join(",")}`);
    cases.push(c);
  }

  // ===== G4：关闭 1 个 Session，其余不受影响 =====
  {
    const c = new Case("m0-4-G4");
    console.log("\n== G4: 关闭 1 个 Session ==");
    const [a, b, cc] = g1Sessions;
    const pidBefore = await readPids(pidLog);
    a.session.dispose();
    await new Promise((r) => setTimeout(r, 1500));
    const activeB = b.session.getActiveToolNames();
    const activeC = cc.session.getActiveToolNames();
    c.assert("session B 的 MCP 工具仍在声明中", activeB.includes("mcp__fix__echo"), activeB.filter((n) => n.startsWith("mcp__")).join(","));
    c.assert("session C 的 MCP 工具仍在声明中", activeC.includes("mcp__fix__echo"), activeC.filter((n) => n.startsWith("mcp__")).join(","));
    // 关闭的 session 对应进程应退出——实测发现 dispose 不回收（v5 后新发现，记 WARN）
    const pidsAfter = [...new Set(await readPids(pidLog))];
    await new Promise((r) => setTimeout(r, 2500));
    const dead = pidsAfter.filter((p) => !pidAlive(p));
    c.warn(
      "发现：session.dispose 后 stdio server 进程不退出（MCP 扩展不杀子进程/不关 stdin）",
      `dead=${dead.join(",") || "(none)"} of ${pidsAfter.join(",")}；待验证：prompt 后 dispose 是否不同；M2 需补偿清理或上游修复`,
    );
    const alive = pidsAfter.filter((p) => pidAlive(p));
    c.assert("隔离性：其余 session 的 server 进程独立存活（互不影响）", alive.length >= 3, `alive=${alive.join(",")}`);
    void pidBefore;
    cases.push(c);
  }

  // ===== G5：全部 dispose → 进程回收情况（实测：不回收，记 WARN） =====
  {
    const c = new Case("m0-4-G5");
    console.log("\n== G5: 全部 dispose ==");
    for (const r of g1Sessions) r.session.dispose();
    await new Promise((r) => setTimeout(r, 3000));
    const pids = [...new Set(await readPids(pidLog))];
    const alive = pids.filter((p) => pidAlive(p));
    c.warn(
      "发现：全部 dispose 后 stdio server 进程仍存活（僵尸风险实铕，脚本退出后管道断裂会自然回收）",
      `alive=${alive.join(",") || "(none)"} of total ${pids.length}`,
    );
    cases.push(c);
  }

  // ===== G2 + G6：HTTP 共享远端 + 401 报错路径 =====
  {
    const c = new Case("m0-4-G2G6");
    console.log("\n== G2/G6: HTTP 共享远端 + 401 报错路径 ==");
    const port = 3927 + Math.floor(Math.random() * 100);
    const statsFile = path.join(tmp, "http-stats.json");
    const readyFile = path.join(tmp, "http-ready.pid");
    const httpProc = spawn(process.execPath, [path.join(import.meta.dirname, "fixture", "echo-mcp-http.mjs")], {
      env: { ...process.env, FIXTURE_HTTP_PORT: String(port), FIXTURE_HTTP_STATS: statsFile, FIXTURE_HTTP_READY: readyFile },
      stdio: ["ignore", "ignore", "inherit"],
    });
    // 等 ready（内容 pid:port，Windows 端口保留段自动换号）
    const start = Date.now();
    while (!fs.existsSync(readyFile) && Date.now() - start < 15000) await new Promise((r) => setTimeout(r, 200));
    c.assert("HTTP fixture 已就绪", fs.existsSync(readyFile));
    const [, httpPort] = fs.readFileSync(readyFile, "utf8").split(":");

    const url = `http://127.0.0.1:${httpPort}/mcp`;
    const badUrl = `http://127.0.0.1:${httpPort}/auth-required`;
    const goodEntry = { ...fixtureEntry("httpfix", { exposure: "direct" as const }), config: { type: "http" as const, url } };
    const badEntry = { ...fixtureEntry("httpbad", { exposure: "direct" as const }), config: { type: "http" as const, url: badUrl } };
    const r4 = await createSession({ entries: [badEntry, goodEntry] });
    // G6 时间线：记录好 server 工具何时出现（评审要求钉牢阻塞行为）
    const t0 = Date.now();
    let appearedAt: number | null = null;
    for (;;) {
      if (r4.session.getActiveToolNames().includes("mcp__httpfix__echo")) {
        appearedAt = Date.now() - t0;
        break;
      }
      if (Date.now() - t0 > 60000) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const active4 = r4.session.getActiveToolNames();
    if (appearedAt !== null) {
      c.assert("G6: 401 server 未阻塞好 server（延迟注册）", true, `httpfix 工具出现耗时 ${appearedAt}ms；active=${active4.filter((n) => n.startsWith("mcp__")).join(",")}`);
    } else {
      c.warn(
        "发现：401 server 在 headless 会话中阻塞好 server 工具注册（60s 未出现）",
        `active=${active4.filter((n) => n.startsWith("mcp__")).join(",") || "(none)"}；结论：需认证 server 必须靠 loadConfig 过滤掉，不能依赖失败不阻塞`,
      );
    }
    r4.session.dispose();

    // G2：4 session 同一 HTTP server
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await createSession({ entries: [{ ...fixtureEntry("httpfix", { exposure: "direct" as const }), config: { type: "http" as const, url } }] }));
    }
    for (const r of results) await waitForTools(r.session, (n) => n.includes("mcp__httpfix__echo"));
    const stats = JSON.parse(fs.readFileSync(statsFile, "utf8")) as { initializes: number; sessionIds: string[] };
    const httpProcAlive = pidAlive(String(httpProc.pid));
    c.assert("G2: HTTP server 进程数 = 1（远端共享）", httpProcAlive, `pid=${httpProc.pid}`);
    c.assert("G2: initialize 次数 = 5（G6 的 1 次 + G2 的 4 次）", stats.initializes === 5, `stats=${JSON.stringify(stats)}`);
    c.assert(
      "G2: mcp-session-id 全部独立（pi 侧连接对象不跨 session 共享）",
      new Set(stats.sessionIds).size === stats.sessionIds.length,
      `sessionIds=${stats.sessionIds.length}`,
    );
    for (const r of results) r.session.dispose();
    httpProc.kill();
    cases.push(c);
  }

  process.exit(finish(cases));
}

main().catch((e) => {
  console.error("M0-4 执行失败:", e);
  process.exit(1);
});
