// /workflows run 子命令参数解析契约（命令层与 workflow 工具共用）
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflowsRunArgs, renderRunStatus } from "../../src/tools/workflow-tools.js";
import { RunManager } from "../../src/manager/run-manager.js";

test("run 参数: 仅脚本路径", () => {
  const r = parseWorkflowsRunArgs(["scripts/smoke.js"]);
  assert.equal(r.scriptPath, "scripts/smoke.js");
  assert.equal(r.args, undefined);
  assert.equal(r.error, undefined);
});

test("run 参数: key=value 按 JSON 转类型, 非 JSON 保持字符串", () => {
  const r = parseWorkflowsRunArgs(["daily-review.js", "topic=性能", "depth=3", "dry=true", "tags=[\"a\",\"b\"]"]);
  assert.equal(r.scriptPath, "daily-review.js");
  assert.deepEqual(r.args, { topic: "性能", depth: 3, dry: true, tags: ["a", "b"] });
});

test("run 参数: 值中含等号时按首个等号切分", () => {
  const r = parseWorkflowsRunArgs(["x.js", "q=a=b"]);
  assert.deepEqual(r.args, { q: "a=b" });
});

test("run 参数: 缺路径或非法 token 返回 error", () => {
  assert.match(parseWorkflowsRunArgs([]).error!, /缺少/);
  assert.match(parseWorkflowsRunArgs(["a.js", "flag"]).error!, /key=value/);
});

test("cancel/stop 选集: 只停在途运行, cancel 未知 id 返回 false", async () => {
  const rm = new RunManager(4);
  rm.register("a");
  rm.register("b");
  rm.register("c");
  rm.finish("b", { status: "completed" });
  const running = rm.list().filter((r) => r.status === "running").map((r) => r.runId);
  assert.deepEqual(running, ["a", "c"]); // stop 全部在途的选集语义
  assert.equal(await rm.cancel("a"), true);
  assert.equal(await rm.cancel("zzz"), false);
});

test("status 渲染: 未知 runId 自防御, 已知 runId 含状态行", () => {
  assert.match(renderRunStatus(null), /未找到/);
  const rm = new RunManager(2);
  rm.register("s1", { label: "lbl" });
  const text = renderRunStatus(rm.status("s1"));
  assert.match(text, /runId: s1/);
  assert.match(text, /running/);
});

// ---- /workflows 路由层（fake pi + 真 RunManager，无模型） ----

import { registerWorkflowsCommand } from "../../extensions/commands/workflows/index.js";

function makeCapture() {
  const notifications: Array<{ text: string; level: string }> = [];
  const ctx = { cwd: "/tmp", ui: { notify: (text: string, level: string) => notifications.push({ text, level }) } };
  const pi: any = { registerCommand: (_name: string, opts: any) => (pi.handler = opts.handler) };
  return { notifications, ctx, pi };
}

function makeDepsStub() {
  return {
    runManager: new RunManager(2),
    makeDeps: () => {
      throw new Error("run 测试不应触达工具依赖");
    },
    deliver: async () => {},
  };
}

test("路由: 无参数显示帮助, cancel/stop 同义去重为一行", async () => {
  const { notifications, ctx, pi } = makeCapture();
  registerWorkflowsCommand(pi, makeDepsStub());
  await pi.handler("", ctx);
  assert.equal(notifications[0].level, "info");
  const helpLines = notifications[0].text.split("\n");
  assert.equal(helpLines[0], "workflow 子命令:");
  assert.equal(helpLines.filter((l) => l.includes("cancel")).length, 1); // stop 不重复出现
});

test("路由: 未知子命令 -> warning + 帮助", async () => {
  const { notifications, ctx, pi } = makeCapture();
  registerWorkflowsCommand(pi, makeDepsStub());
  await pi.handler("foo", ctx);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].text, /未知子命令: foo/);
});

test("路由: dispatch 到子命令（status 缺参 / cancel 无在途）", async () => {
  const { notifications, ctx, pi } = makeCapture();
  registerWorkflowsCommand(pi, makeDepsStub());
  await pi.handler("status", ctx);
  assert.match(notifications[0].text, /用法: \/workflows status/);
  await pi.handler("cancel", ctx);
  assert.match(notifications[1].text, /当前没有在途运行/);
  await pi.handler("stop", ctx); // stop 同样路由到 cancel 实现
  assert.match(notifications[2].text, /当前没有在途运行/);
});
