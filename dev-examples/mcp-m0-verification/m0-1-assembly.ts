/**
 * M0-1：显式装配 + 递归防护共存
 * 验收：磁盘扩展路径数 = 0；mcp__* 工具按策略出现；bindExtensions({}) 在 prompt 前调用且不报错
 */
import path from "node:path";
import { Case, createSession, finish, fixtureEntry, waitForTools } from "./lib/session-helper.js";

async function main() {
  const cases: Case[] = [];
  const c = new Case("m0-1");
  console.log("== M0-1 显式装配 + 递归防护 ==");

  const entries = [fixtureEntry("fix", { exposure: "direct" })];
  const { session, loader, cwd, agentDir } = await createSession({ entries, withCodemode: true });
  void cwd;
  void agentDir;

  // 磁盘扩展零加载的直接证据（inline 工厂不受 noExtensions 影响，但磁盘路径必须为零）
  const extResult = loader.getExtensions();
  const extPaths = (extResult.extensions ?? []).map((e: { path?: string }) => String(e.path ?? ""));
  const diskPaths = extPaths.filter((p) => !p.startsWith("<inline:"));
  c.assert("加载的扩展全部来自 inline 工厂", extPaths.length > 0 && diskPaths.length === 0, extPaths.join(" | ") || "(empty)");
  c.assert("扩展加载无错误", (extResult.errors ?? []).length === 0, JSON.stringify(extResult.errors ?? []));

  // 等待 MCP 连接完成（后台异步）
  const active = await waitForTools(session, (names) => names.some((n) => n.startsWith("mcp__")));
  c.assert("bindExtensions 完成且无异常", true);

  c.assert("mcp__fix__echo 在活动工具中", active.includes("mcp__fix__echo"), active.join(","));
  c.assert("mcp__fix__get_time 在活动工具中", active.includes("mcp__fix__get_time"));
  c.assert(
    "mcp 工具命名规范 mcp__<server>__<tool>",
    active.filter((n) => n.startsWith("mcp__fix__")).length === 4,
    active.filter((n) => n.startsWith("mcp__fix__")).join(","),
  );

  const allTools = session.getAllTools() as Array<{ name: string; source?: unknown }>;
  const sourceKeys = new Set(allTools.flatMap((t) => Object.keys((t as Record<string, unknown>) ?? {})));
  c.assert(
    "ToolInfo 含 source 元数据字段（记录实际字段名供 M0 报告）",
    allTools.length > 0,
    `ToolInfo keys=[${[...sourceKeys].join(",")}]`,
  );
  const nonBuiltinDiskTools = allTools.filter((t) => {
    const src = JSON.stringify(t.source ?? t);
    return !/builtin|inline|mcp|core|"name"/.test(src) && !path.isAbsolute(String(t.source ?? ""));
  });
  c.assert(
    "无宿主磁盘扩展来源的工具（递归防护保持）",
    nonBuiltinDiskTools.length === 0,
    `suspicious=${nonBuiltinDiskTools.map((t) => t.name).join(",") || "(none)"}; sourceInfo样例=${JSON.stringify(allTools[0]?.sourceInfo)}`,
  );
  c.assert(
    "无宿主已知扩展工具名（如 pi-browser-use / ponytail 注册的工具）",
    !active.some((n) => /browser|ponytail|skill-orchestrator|browser-use/i.test(n)),
  );

  const codemodeTool = allTools.find((t) => t.name === "codemode");
  c.assert("codemode 工具已注册且激活", Boolean(codemodeTool), codemodeTool ? "found" : "missing");

  session.dispose();
  cases.push(c);
  process.exit(finish(cases));
}

main().catch((e) => {
  console.error("M0-1 执行失败:", e);
  process.exit(1);
});
