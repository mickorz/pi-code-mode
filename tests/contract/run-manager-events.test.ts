// RunManager 事件出口 + 渲染调度器节流语义（widget 事件驱动化的数据源契约，无模型）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RunManager } from "../../packages/manager/src/run-manager.js";
import { createRenderScheduler } from "../../packages/manager/src/render-scheduler.js";

test("RunManager 事件: register/attach/finish 时序与退订", () => {
  const rm = new RunManager(2);
  const events: any[] = [];
  const off = rm.onEvent((e) => events.push(e));
  rm.register("a", { label: "L" });
  rm.attach("a", { id: "n0", label: "n0", status: "ok" } as any);
  rm.finish("a", { status: "completed", resultPreview: "{}" });
  assert.deepEqual(
    events.map((e) => e.type),
    ["started", "progress", "finished"],
  );
  assert.equal(events[2].status, "completed");
  off();
  rm.register("b");
  assert.equal(events.length, 3); // 退订后不再接收
});

test("RunManager 事件: cancel 触发 stopped, 未知 runId 不触发", async () => {
  const rm = new RunManager(2);
  const events: any[] = [];
  rm.onEvent((e) => events.push(e));
  assert.equal(await rm.cancel("ghost"), false);
  assert.equal(events.length, 0);
  rm.register("a");
  await rm.cancel("a");
  assert.ok(events.some((e) => e.type === "stopped" && e.runId === "a"));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("渲染调度器: lifecycle 微任务即时且同拍去重", async () => {
  let renders = 0;
  const scheduler = createRenderScheduler(() => renders++);
  scheduler.schedule("lifecycle");
  scheduler.schedule("lifecycle");
  scheduler.schedule("lifecycle");
  await sleep(0);
  assert.equal(renders, 1);
  scheduler.dispose();
});

test("渲染调度器: progress 窗口内合并, 跨窗口再触发", async () => {
  let renders = 0;
  const scheduler = createRenderScheduler(() => renders++, 30);
  for (let i = 0; i < 5; i++) scheduler.schedule("progress");
  assert.equal(renders, 0); // 节流窗口内不渲染
  await sleep(50);
  assert.equal(renders, 1); // 窗口收口渲染一次
  scheduler.schedule("progress"); // 新窗口
  await sleep(50);
  assert.equal(renders, 2);
  scheduler.dispose();
});

test("渲染调度器: dispose 清掉挂起节流", async () => {
  let renders = 0;
  const scheduler = createRenderScheduler(() => renders++, 20);
  scheduler.schedule("progress");
  scheduler.dispose();
  await sleep(40);
  assert.equal(renders, 0);
});

test("RunManager 事件: listener 异常被隔离, 不阻断后续监听器与 run 流程", async () => {
  const rm = new RunManager(2);
  const seen: string[] = [];
  const originalError = console.error;
  console.error = () => {}; // 静音预期内的监听器异常日志
  rm.onEvent(() => {
    throw new Error("broken listener");
  });
  rm.onEvent((e) => seen.push(e.type));
  rm.register("a");
  console.error = originalError;
  assert.deepEqual(seen, ["started"]); // 后续监听器仍收到事件
  assert.equal(rm.list().length, 1); // register 流程未被打断
});
