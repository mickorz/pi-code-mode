// AgentAdapter 契约测试（不调 LLM, 全确定性）
// 验证 Mock Adapter 满足契约; 同一套断言即 M1 PiAgentAdapter 的验收靶子
// 用法: npx tsx --test contract.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MockAgentAdapter } from "./mock-adapter.js";
import type { AgentAdapter, AgentResult } from "../../src/adapter/types.js";

const REQ = (prompt = "test"): any => ({ prompt });

/** Engine 侧消费规则: 非 ok status 转 throw（契约 3.1, 对齐 opencode「脚本侧只见值或异常」） */
function assertOkOrThrow(result: AgentResult): unknown {
  if (result.status !== "ok") {
    const err = new Error(result.error?.message ?? `agent ${result.status}`);
    (err as any).kind = result.error?.kind ?? "unknown";
    (err as any).agentStatus = result.status;
    throw err;
  }
  return result.output.value;
}

test("契约: execute 返回 ok 形态完整", async () => {
  const adapter: AgentAdapter = new MockAgentAdapter({
    default: { status: "ok", output: { type: "text", value: "hello" }, usage: { inputTokens: 10, outputTokens: 5 }, sessionId: "x" },
  });
  const r = await adapter.execute(REQ(), { executionId: randomUUID(), runId: "run-1" });
  assert.equal(r.status, "ok");
  assert.equal(assertOkOrThrow(r), "hello");
  assert.equal(r.usage?.outputTokens, 5);
  assert.ok(r.sessionId.length > 0);
});

test("契约: cancelled/timeout 允许 usage 缺省且不冒充 0", async () => {
  const adapter: AgentAdapter = new MockAgentAdapter({
    byExecutionId: {
      "id-cancelled": { status: "cancelled", output: { type: "text", value: "" }, sessionId: "s1" },
      "id-timeout": { status: "timeout", output: { type: "text", value: "" }, sessionId: "s2" },
    },
  });
  const c = await adapter.execute(REQ(), { executionId: "id-cancelled", runId: "r" });
  assert.equal(c.status, "cancelled");
  assert.equal(c.usage, undefined, "取消时 usage 必须缺省, 不得为 0");
  assert.throws(() => assertOkOrThrow(c), /cancelled/);

  const t = await adapter.execute(REQ(), { executionId: "id-timeout", runId: "r" });
  assert.equal(t.usage, undefined);
  assert.throws(() => assertOkOrThrow(t), /timeout/);
});

test("契约: error 携带 kind, unknown 为合法归类", async () => {
  const adapter: AgentAdapter = new MockAgentAdapter({
    default: { status: "error", output: { type: "text", value: "" }, error: { kind: "unknown", message: "boom" }, sessionId: "s" },
  });
  const r = await adapter.execute(REQ(), { executionId: randomUUID(), runId: "r" });
  assert.throws(() => assertOkOrThrow(r), (e: any) => e.kind === "unknown" && e.agentStatus === "error");
});

test("契约: cancel 幂等且未知 id 静默成功", async () => {
  const adapter: AgentAdapter = new MockAgentAdapter({
    default: { status: "ok", output: { type: "text", value: "x" }, sessionId: "s" },
  });
  await adapter.cancel("never-dispatched");
  await adapter.cancel("never-dispatched"); // 二次取消不抛
  assert.equal(adapter.cancelled.length, 2);
});

test("契约: executionId 由 Engine 生成并原样到达 Adapter", async () => {
  const adapter = new MockAgentAdapter({
    default: { status: "ok", output: { type: "text", value: "x" }, sessionId: "s" },
  });
  const id = randomUUID();
  await adapter.execute(REQ(), { executionId: id, runId: "r" });
  assert.equal(adapter.calls[0].ctx.executionId, id);
  assert.equal(adapter.calls[0].request.prompt, "test");
});

test("契约: 取消在途执行（signal 触发 Adapter 返回 cancelled 终态）", async () => {
  // 模拟: Engine 在 attempt controller abort 后, Adapter 仍返回终态（cancelled）而非挂起
  const adapter = new MockAgentAdapter({
    latencyMs: 30,
    default: { status: "cancelled", output: { type: "text", value: "" }, sessionId: "s" },
  });
  const p = adapter.execute(REQ(), { executionId: randomUUID(), runId: "r" });
  const r = await p;
  assert.equal(r.status, "cancelled");
});

test("契约: execute 超时由 Engine 计时收尾（signal 中止时提前返回 cancelled）", async () => {
  const adapter = new MockAgentAdapter({
    latencyMs: 200,
    default: { status: "ok", output: { type: "text", value: "late" }, sessionId: "s" },
  });
  // Engine 侧: timeoutMs 到点 abort signal; Adapter 响应 signal 提前返回 cancelled（不等 latency 走完）
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  const t0 = Date.now();
  const r = await adapter.execute({ ...REQ(), signal: ac.signal } as any, { executionId: randomUUID(), runId: "r" });
  const elapsed = Date.now() - t0;
  assert.equal(r.status, "cancelled");
  assert.ok(elapsed < 100, `应在 abort 后提前返回（实际 ${elapsed}ms，不应等满 latency 200ms）`);
});
