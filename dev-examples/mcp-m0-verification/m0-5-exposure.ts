/**
 * M0-5：exposure 四模式行为实测（声明层已由 M0-1/M0-2 覆盖，本脚本验证调用行为）
 * A: direct → 模型直调成功（对照组）
 * B: hidden 不可达 → codemode searchTools 找不到 / 调用报错，call log 无 echo
 * C: deferred → 经 tool_search 加载后调用成功
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Case, createSession, finish, fixtureEntry, waitForTools } from "./lib/session-helper.js";

function makeCallLogFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "m0-5-")), "calls.log");
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

  // ===== A：direct 直调成功（对照） =====
  {
    const c = new Case("m0-5A");
    console.log("\n== M0-5A direct 直调成功 ==");
    const callLog = makeCallLogFile();
    process.env.FIXTURE_CALL_LOG = callLog;
    const { session } = await createSession({ entries: [fixtureEntry("fix", { exposure: "direct" })], needModel: true });
    await waitForTools(session, (n) => n.includes("mcp__fix__echo"));
    const reply = await runPrompt(session, 'Call the mcp__fix__echo tool with argument {"text":"hello-m0-5"}. Report the exact text the tool returned.');
    c.assert("direct 工具调用成功（返回值出现在回复中）", reply.includes("hello-m0-5"), `reply=${reply.slice(0, 200)}`);
    c.assert("调用到达 server", readCalls(callLog).includes("echo"), `calls=${JSON.stringify(readCalls(callLog))}`);
    session.dispose();
    cases.push(c);
  }

  // ===== B：hidden 不可达（codemode searchTools 找不到） =====
  {
    const c = new Case("m0-5B");
    console.log("\n== M0-5B hidden 不可达 ==");
    const callLog = makeCallLogFile();
    process.env.FIXTURE_CALL_LOG = callLog;
    // 全部 hidden；codemode/tool_search 已激活，模型能写脚本尝试
    const { session } = await createSession({ entries: [fixtureEntry("fix", { exposure: "hidden" })], needModel: true });
    await new Promise((r) => setTimeout(r, 3000));
    const reply = await runPrompt(
      session,
      'Use the codemode tool. Write a JS script that: (1) uses searchTools("echo") to search for an MCP tool named mcp__fix__echo, (2) tries to execute it with {"text":"hi"}, (3) returns whatever happened (found or not found, error message if any). Report exactly what the script returned.',
    );
    const calls = readCalls(callLog);
    c.assert(
      "hidden 工具调用未到达 server",
      !calls.includes("echo"),
      `calls=${JSON.stringify(calls)}; reply=${reply.slice(0, 300)}`,
    );
    const notFound = /not found|no (matching )?tools|no results|找不到|无匹配|0 tools|empty/i.test(reply);
    const denied = /hidden|denied|unavailable|not available|error/i.test(reply);
    c.assert(
      "searchTools 找不到或调用被拒（hidden 无可达通道）",
      notFound || denied,
      `notFound=${notFound} denied=${denied}; reply=${reply.slice(0, 400)}`,
    );
    session.dispose();
    cases.push(c);
  }

  // ===== C：deferred 经 tool_search 加载后调用 =====
  {
    const c = new Case("m0-5C");
    console.log("\n== M0-5C deferred 经 tool_search ==");
    const callLog = makeCallLogFile();
    process.env.FIXTURE_CALL_LOG = callLog;
    const { session } = await createSession({
      entries: [fixtureEntry("fix", { exposure: "deferred" })],
      needModel: true,
    });
    await new Promise((r) => setTimeout(r, 3000));
    const reply = await runPrompt(
      session,
      'The MCP tool mcp__fix__echo is not declared yet. Use the tool_search tool to search for "echo", load it, then call it with {"text":"deferred-ok"}. Report the exact text the tool returned.',
    );
    const calls = readCalls(callLog);
    c.assert("deferred 工具经 tool_search 加载后调用到达 server", calls.includes("echo"), `calls=${JSON.stringify(calls)}; reply=${reply.slice(0, 300)}`);
    c.assert("调用结果正确", reply.includes("deferred-ok"), `reply=${reply.slice(0, 200)}`);
    session.dispose();
    cases.push(c);
  }

  process.exit(finish(cases));
}

main().catch((e) => {
  console.error("M0-5 执行失败:", e);
  process.exit(1);
});
