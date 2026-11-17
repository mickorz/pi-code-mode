/**
 * M0-2：loadConfig 注入过滤（server 级 + 工具级）
 * 用例 A：server 白名单——未配置的 server 不连接（PID log 证据）
 * 用例 B：工具级授权独立生效——server 连接但只放行 echo，其余 hidden（官方 toolExposure 语义）
 * 用例 C：deny 压 direct 反向——server exposure=direct + echo 被 hidden，echo 仍不可达
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Case, createSession, finish, fixtureEntry, waitForTools } from "./lib/session-helper.js";

async function readPids(file: string): Promise<string[]> {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("pid="));
  } catch {
    return [];
  }
}

async function main() {
  const cases: Case[] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "m0-pid-"));

  // ===== 用例 A：server 白名单 =====
  {
    const c = new Case("m0-2A");
    console.log("\n== M0-2A server 白名单 ==");
    const pidA = path.join(tmp, "pid-a.log");
    const pidB = path.join(tmp, "pid-b.log");
    process.env.FIXTURE_PID_LOG = pidA;
    const entryA = fixtureEntry("fix-a", { exposure: "direct" });
    entryA.config.env = { FIXTURE_PID_LOG: pidA };
    const entryB = fixtureEntry("fix-b", { exposure: "direct" });
    entryB.config.env = { FIXTURE_PID_LOG: pidB };
    // 策略：只放行 fix-a（loadConfig 只返回 A，B 被过滤掉）
    const { session } = await createSession({ entries: [entryA] });
    const active = await waitForTools(session, (n) => n.includes("mcp__fix_a__echo"));
    // 实证发现：server 名中的 "-" 在 mcp__ 工具名中替换为 "_"（mcpNamespace 语义，mcp-servers.d.ts:110）
    c.assert("白名单内 fix-a 已连接并注册工具", active.includes("mcp__fix_a__echo"), active.join(","));
    c.assert("未授权 fix-b 无任何工具", !active.some((n) => n.startsWith("mcp__fix_b__")));
    await new Promise((r) => setTimeout(r, 1000)); // 给 B 假如误连接的窗口
    const pidsB = await readPids(pidB);
    c.assert("fix-b 进程从未启动（PID log 为空）", pidsB.length === 0, `pidsB=${JSON.stringify(pidsB)}`);
    const pidsA = await readPids(pidA);
    c.assert("fix-a 进程已启动（PID log 证据）", pidsA.length >= 1, `pidsA=${JSON.stringify(pidsA)}`);
    session.dispose();
    cases.push(c);
  }

  // ===== 用例 B：工具级授权独立生效（默认 hidden + 显式开放） =====
  {
    const c = new Case("m0-2B");
    console.log("\n== M0-2B 工具级授权独立生效 ==");
    process.env.FIXTURE_PID_LOG = path.join(tmp, "pid-c.log");
    const entry = fixtureEntry("fix", {
      exposure: "hidden", // server 默认全部隐藏
      toolExposure: { echo: "codemode", get_time: "codemode" }, // 显式开放 2 个
    });
    const { session } = await createSession({ entries: [entry] });
    await new Promise((r) => setTimeout(r, 3000)); // codemode exposure 不进 active 声明，等待连接
    const active = session.getActiveToolNames();
    const all = session.getAllTools() as Array<{ name: string; exposure?: string }>;
    const mcpTools = all.filter((t) => t.name.startsWith("mcp__fix__"));
    console.log(
      "  [debug] exposure 原始值:",
      mcpTools.map((t) => `${t.name}=${JSON.stringify((t as Record<string, unknown>).exposure)}`).join(" "),
    );
    c.assert("server 已连接（工具已发现）", mcpTools.length === 4, `discovered=${mcpTools.map((t) => t.name).join(",")}`);
    const exposed = mcpTools.filter((t) => t.exposure === "deferred").map((t) => t.name);
    const hidden = mcpTools.filter((t) => t.exposure === "hidden").map((t) => t.name);
    c.assert(
      "显式开放的工具经 discovery 可达（注册层 codemode→deferred 映射，tools.js:25 toToolExposure）",
      exposed.sort().join(",") === "mcp__fix__echo,mcp__fix__get_time",
      `exposed=${exposed.join(",")}`,
    );
    c.assert(
      "未授权工具 exposure=hidden（Server 授权 ≠ 工具授权）",
      hidden.sort().join(",") === "mcp__fix__add,mcp__fix__slow",
      `hidden=${hidden.join(",")}`,
    );
    c.assert("hidden 工具不出现在模型声明", !active.some((n) => n.startsWith("mcp__")), active.join(","));
    session.dispose();
    cases.push(c);
  }

  // ===== 用例 C：deny 压 direct 反向 =====
  {
    const c = new Case("m0-2C");
    console.log("\n== M0-2C deny 压过 server direct ==");
    process.env.FIXTURE_PID_LOG = path.join(tmp, "pid-d.log");
    const entry = fixtureEntry("fix", {
      exposure: "direct",
      toolExposure: { echo: "hidden", add: "hidden" }, // deny 两个
    });
    const { session } = await createSession({ entries: [entry] });
    const active = await waitForTools(session, (n) => n.some((x) => x.startsWith("mcp__")));
    const denied = ["echo", "add"].filter((t) => active.includes(`mcp__fix__${t}`));
    const allowed = ["get_time", "slow"].filter((t) => active.includes(`mcp__fix__${t}`));
    c.assert(
      "被 deny 的工具在 server exposure=direct 下仍不可达",
      denied.length === 0,
      `deniedVisible=${denied.join(",") || "(none)"}`,
    );
    c.assert(
      "未被 deny 的工具保持 direct 声明",
      allowed.length === 2,
      `allowed=${allowed.join(",")}`,
    );
    session.dispose();
    cases.push(c);
  }

  process.exit(finish(cases));
}

main().catch((e) => {
  console.error("M0-2 执行失败:", e);
  process.exit(1);
});
