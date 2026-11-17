/**
 * M0-3：工具管线权限拦截（beforeToolCall，direct + codemode 双路径）
 * 拦截扩展：pi.on("tool_call") 对 mcp__fix__echo 返回 { block: true, reason }
 * 验证：A) direct 声明的工具直接调用被拦 B) codemode 脚本内调用同样被拦（parentToolCallId 标识）
 * 硬证据：fixture call log——被 block 的调用不应到达 server
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Case, createSession, finish, fixtureEntry, waitForTools } from "./lib/session-helper.js";

/** 拦截扩展工厂：记录 tool_call 事件 + block echo */
function makeInterceptor(log: { blocked: Array<{ toolName: string; parentToolCallId?: string }> }) {
  return ((pi: any) => {
    pi.on("tool_call", (event: any) => {
      if (event.toolName === "mcp__fix__echo") {
        log.blocked.push({ toolName: event.toolName, parentToolCallId: event.parentToolCallId });
        return { block: true, reason: "M0-3 policy: echo is denied for this agent" };
      }
      return {};
    });
  }) as any;
}

function makeCallLogFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "m0-3-")), "calls.log");
}

function readCalls(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

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
  const cases: Case[] = [];

  // ===== 用例 A：direct 声明工具的调用被拦截 =====
  {
    const c = new Case("m0-3A");
    console.log("\n== M0-3A direct 路径拦截 ==");
    const callLog = makeCallLogFile();
    process.env.FIXTURE_CALL_LOG = callLog;
    const log = { blocked: [] as Array<{ toolName: string; parentToolCallId?: string }> };
    const { session } = await createSession({
      entries: [fixtureEntry("fix", { exposure: "direct" })],
      needModel: true,
      extraFactories: [makeInterceptor(log)],
    });
    await waitForTools(session, (n) => n.includes("mcp__fix__echo"));
    const reply = await runPrompt(session, 'Call the mcp__fix__echo tool with argument {"text":"hello"}. Then report exactly what the tool returned.');
    c.assert("拦截扩展收到 echo 的 tool_call 事件", log.blocked.some((b) => b.toolName === "mcp__fix__echo"), JSON.stringify(log.blocked));
    c.assert(
      "模型被告知拦截原因",
      /policy|denied|not allowed|无法|拒绝|blocked/i.test(reply),
      `reply=${reply.slice(0, 300)}`,
    );
    const calls = readCalls(callLog);
    c.assert(
      "被 block 的调用未到达 server（call log 无 echo）",
      !calls.includes("echo"),
      `calls=${JSON.stringify(calls)}`,
    );
    session.dispose();
    cases.push(c);
  }

  // ===== 用例 B：codemode 脚本内调用同样被拦截（parentToolCallId 标识） =====
  {
    const c = new Case("m0-3B");
    console.log("\n== M0-3B codemode 路径拦截 ==");
    const callLog = makeCallLogFile();
    process.env.FIXTURE_CALL_LOG = callLog;
    const log = { blocked: [] as Array<{ toolName: string; parentToolCallId?: string }> };
    const { session } = await createSession({
      entries: [fixtureEntry("fix", { exposure: "codemode" })],
      needModel: true,
      extraFactories: [makeInterceptor(log)],
    });
    await waitForTools(session, () => true, 4000); // codemode 不进声明，等连接
    const reply = await runPrompt(
      session,
      'Use the codemode tool. Write a JS script that: (1) uses searchTools("echo") to find the MCP tool named mcp__fix__echo, (2) executes that tool with {"text":"hi"}, (3) returns its result text. Then report exactly what the script returned.',
    );
    c.assert(
      "codemode 脚本内的 echo 调用同样被拦截",
      log.blocked.some((b) => b.toolName === "mcp__fix__echo"),
      `blocked=${JSON.stringify(log.blocked)}`,
    );
    const viaScript = log.blocked.some((b) => b.parentToolCallId !== undefined);
    c.warn(
      "codemode 内调用带 parentToolCallId 标识（嵌套调用可归因到脚本调用）",
      `viaScript=${viaScript}`,
    );
    c.assert(
      "模型被告知拦截原因（codemode 路径）",
      /policy|denied|not allowed|无法|拒绝|blocked/i.test(reply),
      `reply=${reply.slice(0, 300)}`,
    );
    const calls = readCalls(callLog);
    c.assert("被 block 的脚本调用未到达 server", !calls.includes("echo"), `calls=${JSON.stringify(calls)}`);
    session.dispose();
    cases.push(c);
  }

  process.exit(finish(cases));
}

main().catch((e) => {
  console.error("M0-3 执行失败:", e);
  process.exit(1);
});
