/**
 * M0-6：Journal 可观测范围（运行时钉死静态结论）+ 事件流载荷枚举
 * 6a: SDK session.subscribe 事件流——工具事件类型与载荷清单（M2 数据通道前提）
 * 6b: 本仓库真实链路（PiAgentAdapter -> runWorkflow -> JournalStore）——
 *     实跑带工具调用的 agent，检查 journal entry 是否含工具级记录（静态结论：不含）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Case, createSession, finish, fixtureEntry, waitForTools } from "./lib/session-helper.js";

import { agentAdapterToRunner } from "../../src/adapter/agent-adapter.js";
import { PiAgentAdapter } from "../../src/adapter/pi-agent-adapter.js";
import { JournalStore } from "../../src/engine/persistence/journal.js";
import { runWorkflow } from "../../src/engine/runtime/workflow-runtime.js";
import type { JournalEntry } from "../../src/engine/types/index.js";

async function main() {
  const cases: Case[] = [];

  // ===== 6a：事件流载荷枚举 =====
  {
    const c = new Case("m0-6A");
    console.log("\n== M0-6A session.subscribe 事件流枚举 ==");
    const { session } = await createSession({ entries: [fixtureEntry("fix", { exposure: "direct" })], needModel: true });
    await waitForTools(session, (n) => n.includes("mcp__fix__echo"));
    const events: Array<Record<string, unknown>> = [];
    session.subscribe((event: any) => {
      events.push({ type: event.type, keys: Object.keys(event ?? {}) });
    });
    await session.prompt('Call the mcp__fix__echo tool with {"text":"evt-probe"} and report the result.');
    // 事件类型清单
    const byType = new Map<string, number>();
    for (const e of events) byType.set(String(e.type), (byType.get(String(e.type)) ?? 0) + 1);
    const typeList = [...byType.entries()].map(([t, n]) => `${t}x${n}`).join(", ");
    c.assert("事件流已收集", events.length > 0, `总事件数=${events.length}`);
    console.log(`  [info] 事件类型清单: ${typeList}`);
    // 工具事件载荷：找 tool_execution / tool 相关事件
    const toolEvents = events.filter((e) => String(e.type).includes("tool"));
    c.assert(
      "事件流含工具级事件（M2 数据通道前提）",
      toolEvents.length > 0,
      `工具事件=${[...new Set(toolEvents.map((e) => e.type))].join(",") || "(none)"}`,
    );
    // dump 一个工具事件的完整载荷样例
    const sample = events.find((e) => String(e.type).includes("tool_execution_start") || String(e.type).includes("tool_call"));
    if (sample) {
      console.log(`  [info] 工具事件样例: ${JSON.stringify(sample).slice(0, 500)}`);
    }
    fs.mkdirSync(path.join(import.meta.dirname, "results"), { recursive: true });
    fs.writeFileSync(
      path.join(import.meta.dirname, "results", "m0-6a-events-sample.json"),
      JSON.stringify(events.filter((e) => String(e.type).includes("tool")).slice(0, 20), null, 2),
      "utf8",
    );
    session.dispose();
    cases.push(c);
  }

  // ===== 6b：本仓库链路 journal 可观测范围 =====
  {
    const c = new Case("m0-6B");
    console.log("\n== M0-6B 本仓库链路 journal 可观测范围 ==");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m0-6b-"));
    const journal = new JournalStore(dir);
    const runId = "m0-6-probe";
    const adapter = new PiAgentAdapter();
    const entries = [];
    void entries;
    const runner = agentAdapterToRunner(adapter);
    const journalEntries: Array<JournalEntry & { key: string }> = [];
    const executions: Array<{ key: string; execution: unknown }> = [];
    const script = `
export const meta = { name: "m0_6_probe", description: "journal 粒度探针" };
const r = await agent("Run the bash tool with command: echo m0-6-probe-output. Then report the exact output text.");
return r;
`;
    const result = await runWorkflow(script, {
      runId,
      agent: runner,
      concurrency: 1,
      agentTimeoutMs: 120000,
      cwd: dir,
      onAgentJournal: (entry) => {
        journalEntries.push(entry);
        journal.append(runId, entry.key, entry);
      },
      onAgentExecution: (payload) => {
        executions.push(payload);
        journal.recordExecution(runId, payload.key, payload.execution);
      },
    });
    c.assert("workflow 执行成功", Boolean(result), `result=${JSON.stringify(result).slice(0, 200)}`);
    const replyText = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
    c.assert("agent 输出含 bash 执行产物", replyText.includes("m0-6-probe-output"), `reply=${replyText.slice(0, 200)}`);

    // 检查 journal entry 的字段粒度
    c.assert("journal 已有成功 entry", journalEntries.length >= 1, `entries=${journalEntries.length}`);
    const entry = journalEntries[0];
    const entryKeys = Object.keys(entry);
    console.log(`  [info] journal entry 字段: ${entryKeys.join(", ")}`);
    const entryStr = JSON.stringify(entry);
    c.assert(
      "静态结论钉死：journal entry 无工具级记录（无 toolCalls/toolExecution/工具名等字段）",
      !/toolCalls|tool_executions|"toolName"|tool_execution/i.test(entryStr) || !entryKeys.some((k) => /tool/i.test(k)),
      `entryKeys=${entryKeys.join(",")}`,
    );
    c.assert("entry 含 agent 级结果（hash/result）", "hash" in entry && "result" in entry, `keys=${entryKeys.join(",")}`);

    // 落盘文件复核（JournalStore 默认目录 .opencode-workflows/journal，见 journal.ts JOURNAL_DIR）
    const file = path.join(dir, ".opencode-workflows", "journal", `${runId}.json`);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    const diskEntry = Object.values(onDisk.entries)[0] as Record<string, unknown>;
    c.assert(
      "落盘 journal 文件同样无工具级条目（键名无 tool*、result 无 toolCallId 结构）",
      !Object.keys(diskEntry).some((k) => /tool/i.test(k)) && !/toolCallId/.test(JSON.stringify(diskEntry.result ?? "")),
      `disk keys=${Object.keys(diskEntry).join(",")}`,
    );
    cases.push(c);
  }

  process.exit(finish(cases));
}

main().catch((e) => {
  console.error("M0-6 执行失败:", e);
  process.exit(1);
});
