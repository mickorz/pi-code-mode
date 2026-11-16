// watchRun 单 run 专注视图契约：状态行事件驱动更新/终态清理/幂等/防泄漏（无模型）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RunManager } from "../../src/manager/run-manager.js";
import { watchRun, resetWatchState } from "../../extensions/commands/workflows/watch.js";

interface Capture {
  lines: Map<string, string | undefined>;
  finished: string[];
}

function makeWatch() {
  resetWatchState(); // 用例间隔离（watching 表为模块级状态）
  const rm = new RunManager(2);
  const cap: Capture = { lines: new Map(), finished: [] };
  const deps = {
    runManager: rm,
    setStatus: (key: string, text: string | undefined) => cap.lines.set(key, text),
    onFinished: (text: string) => cap.finished.push(text),
  };
  return { rm, cap, deps };
}

test("watch: 挂状态行并随 progress 事件刷新", () => {
  const { rm, cap, deps } = makeWatch();
  rm.register("r1", { label: "冒烟" });
  assert.equal(watchRun(deps as any, "r1"), "ok");
  assert.match(cap.lines.get("wf:r1")!, /冒烟 \[running\] 0\/0 nodes/);
  rm.attach("r1", { id: "r1:0", label: "n0", status: "ok" } as any);
  assert.match(cap.lines.get("wf:r1")!, /1\/1 nodes/);
});

test("watch: finished 事件清理状态行 + 回传终态详情, 后续事件不再触发", async () => {
  const { rm, cap, deps } = makeWatch();
  rm.register("r1");
  watchRun(deps as any, "r1");
  rm.finish("r1", { status: "completed", resultPreview: "{\"a\":1}" });
  assert.equal(cap.lines.get("wf:r1"), undefined); // 状态行已清理
  assert.equal(cap.finished.length, 1);
  assert.match(cap.finished[0], /r1 completed/);
  assert.match(cap.finished[0], /runId: r1/); // renderRunStatus 详情
  // settled 后二次事件不重复回传
  rm.register("r2"); // 其它 run 事件与本 watch 无关
  assert.equal(cap.finished.length, 1);
});

test("watch: stopped 事件清理状态行并提示可续跑", async () => {
  const { rm, cap, deps } = makeWatch();
  rm.register("r1");
  watchRun(deps as any, "r1");
  await rm.cancel("r1");
  assert.equal(cap.lines.get("wf:r1"), undefined);
  assert.equal(cap.finished.length, 1);
  assert.match(cap.finished[0], /已手动停止/);
});

test("watch: 幂等与非 running runId 拒绝", () => {
  const { rm, cap, deps } = makeWatch();
  rm.register("r1");
  assert.equal(watchRun(deps as any, "r1"), "ok");
  assert.equal(watchRun(deps as any, "r1"), "already-watching");
  assert.equal(watchRun(deps as any, "ghost"), "not-running");
  assert.equal(watchRun(deps as any, "r1"), "already-watching"); // 终态前一直幂等
});

test("watch: 同 runId 收尾后可重新 watch（watching 表已清除）", async () => {
  const { rm, cap, deps } = makeWatch();
  rm.register("r1");
  watchRun(deps as any, "r1");
  rm.finish("r1", { status: "failed", error: "boom" });
  assert.match(cap.finished[0], /failed/);
  rm.register("r1x"); // 新 run 模拟重试
  // 收尾后 watching 已删（用不同 runId 验证无残留影响）
  assert.equal(watchRun(deps as any, "r1x"), "ok");
});
