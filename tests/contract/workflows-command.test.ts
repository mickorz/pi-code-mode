// /workflows run 子命令参数解析契约（命令层与 workflow 工具共用）
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflowsRunArgs } from "../../src/tools/workflow-tools.js";

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
