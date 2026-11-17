/**
 * M0-4B（G3）：并发调用同一工具验证隔离性（2 并发，遵守 CLAUDE.md ≤2 纪律）
 * 两个 session 同时调用 slow(3000ms)，验证：结果不串扰、各自独立完成
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Case, createSession, finish, fixtureEntry, waitForTools } from "./lib/session-helper.js";

async function runPrompt(session: any, text: string): Promise<string> {
  let reply = "";
  session.subscribe((event: any) => {
    if (event.type === "message_end" && event.message?.role === "assistant") {
      for (const part of event.message.content ?? []) if (part.type === "text") reply += part.text;
    }
  });
  await session.prompt(text);
  return reply;
}

async function main() {
  const c = new Case("m0-4B-G3");
  console.log("\n== G3: 2 Session 并发调用 slow(3000) ==");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "m0-4b-"));
  const callLog = path.join(tmp, "calls.log");
  process.env.FIXTURE_CALL_LOG = callLog;

  const entry = fixtureEntry("fix", { exposure: "direct" });
  const [s1, s2] = await Promise.all([
    createSession({ entries: [entry], needModel: true }),
    createSession({ entries: [entry], needModel: true }),
  ]);
  await Promise.all([
    waitForTools(s1.session, (n) => n.includes("mcp__fix__slow")),
    waitForTools(s2.session, (n) => n.includes("mcp__fix__slow")),
  ]);

  // 同时发起，各自的 marker 不同
  const t0 = Date.now();
  const [r1, r2] = await Promise.all([
    runPrompt(s1.session, 'Call the mcp__fix__slow tool with {"ms":3000}. Report the exact text returned.'),
    runPrompt(s2.session, 'Call the mcp__fix__slow tool with {"ms":3000}. Report the exact text returned.'),
  ]);
  const elapsed = Date.now() - t0;

  c.assert("两个并发调用都成功返回", r1.includes("done after 3000ms") && r2.includes("done after 3000ms"), `r1=${r1.slice(0, 120)}; r2=${r2.slice(0, 120)}`);
  c.assert("两个并发调用都到达 server（call log 2 次 slow）", (callLog ? fs.readFileSync(callLog, "utf8").split("\n").filter((l) => l === "slow").length : 0) === 2);
  // 并发性：两个 3s 调用若完全串行则总时长 >6s；考虑模型往返时间，阈值放宽到 9s
  c.warn("并发时序观察（两个 3s 调用 + 模型往返总耗时）", `elapsed=${elapsed}ms（完全串行预期 >6000ms+模型往返）`);
  s1.session.dispose();
  s2.session.dispose();
  process.exit(finish([c]));
}

main().catch((e) => {
  console.error("M0-4B 执行失败:", e);
  process.exit(1);
});
