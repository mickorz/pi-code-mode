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
