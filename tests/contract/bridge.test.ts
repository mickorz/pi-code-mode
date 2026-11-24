// 契约桥接器测试：AgentAdapter -> AgentSessionRunner 的语义转换
// 对齐审计 §2：Engine 消费 execution.value/type；错误 throw 且 abort 归类靠消息匹配
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgentAdapter } from "./mock-adapter.js";
import { agentAdapterToRunner } from "../../packages/adapter/src/agent-adapter.js";
import { wrapError } from "../../packages/engine/src/runtime/errors.js";
import type { AgentSessionRunner } from "../../packages/engine/src/agent/session-runner.js";

function makeRunner(script: ConstructorParameters<typeof MockAgentAdapter>[0]): {
  runner: AgentSessionRunner;
  adapter: MockAgentAdapter;
} {
  const adapter = new MockAgentAdapter(script);
  return { runner: agentAdapterToRunner(adapter), adapter };
}

test("桥接: ok 文本结果 -> AgentExecutionResult text 透传", async () => {
  const { runner } = makeRunner({
    default: { status: "ok", output: { type: "text", value: "hello" }, usage: { inputTokens: 3, outputTokens: 2 }, sessionId: "s" },
  });
  const r = await runner.run("hi");
  // sessionId 由 Adapter 分配（Mock 生成 mock-<uuid>），契约不约束其值，只要求非空
  assert.equal(r.type, "text");
  assert.equal(r.value, "hello");
  assert.ok(r.sessionId.length > 0);
});

test("桥接: ok 结构化结果 -> structured 透传（engine 按 execution.type 消费）", async () => {
  const { runner } = makeRunner({
    default: { status: "ok", output: { type: "structured", value: { a: 1 } }, sessionId: "s" },
  });
  const r = await runner.run("hi");
  assert.equal(r.type, "structured");
  assert.deepEqual(r.value, { a: 1 });
});

test("桥接: cancelled -> throw 且被 wrapError 归类为 WORKFLOW_ABORTED", async () => {
  const { runner } = makeRunner({
    default: { status: "cancelled", output: { type: "text", value: "" }, sessionId: "s" },
  });
  await assert.rejects(runner.run("hi"), (e: any) => {
    const wrapped = wrapError(e);
    return wrapped.code === "WORKFLOW_ABORTED";
  });
});

test("桥接: timeout -> throw 且归类 WORKFLOW_ABORTED（Engine 统一计时收尾语义）", async () => {
  const { runner } = makeRunner({
    default: { status: "timeout", output: { type: "text", value: "" }, sessionId: "s" },
  });
  await assert.rejects(runner.run("hi"), (e: any) => wrapError(e).code === "WORKFLOW_ABORTED");
});

test("桥接: error/unknown -> throw 且归类 AGENT_FAILED recoverable（opencode 默认语义）", async () => {
  const { runner } = makeRunner({
    default: { status: "error", output: { type: "text", value: "" }, error: { kind: "unknown", message: "boom" }, sessionId: "s" },
  });
  await assert.rejects(runner.run("hi"), (e: any) => {
    const wrapped = wrapError(e);
    return wrapped.code === "AGENT_FAILED" && wrapped.recoverable === true && e.message.includes("boom");
  });
});

test("桥接: usage -> onUsage（AgentUsage 形态 total=input+output）", async () => {
  const { runner } = makeRunner({
    default: { status: "ok", output: { type: "text", value: "x" }, usage: { inputTokens: 10, outputTokens: 4 }, sessionId: "s" },
  });
  let seen: any = null;
  await runner.run("hi", { onUsage: (u) => (seen = u) });
  assert.deepEqual(seen, { input: 10, output: 4, total: 14, cost: 0 });
});

test("桥接: onSessionCreated 经 session-created 事件触发", async () => {
  const adapter = new MockAgentAdapter({
    default: { status: "ok", output: { type: "text", value: "x" }, sessionId: "s" },
  });
  // Mock 在 execute 后才返回 sessionId；契约要求 Adapter 建 session 即发事件。
  // 这里以包装 Adapter 模拟真实时序：
  const wrapped: any = {
    async execute(request: any, ctx: any) {
      ctx.onEvent?.({ type: "session-created", executionId: ctx.executionId, sessionId: "early-sid" });
      return adapter.execute(request, ctx);
    },
    async cancel(id: string) {
      return adapter.cancel(id);
    },
  };
  let sid: string | null = null;
  await agentAdapterToRunner(wrapped).run("hi", { onSessionCreated: (s) => (sid = s) });
  assert.equal(sid, "early-sid");
});

test("桥接: AgentRunOptions 字段映射（model/directory/schema/signal）", async () => {
  const { runner, adapter } = makeRunner({
    default: { status: "ok", output: { type: "text", value: "x" }, sessionId: "s" },
  });
  const ac = new AbortController();
  await runner.run("hi", {
    model: "zhipu/glm-5.3-flash",
    directory: "E:/tmp/wt-1",
    schema: { type: "object" },
    signal: ac.signal,
  });
  const req = adapter.calls[0].request;
  assert.equal(req.model, "zhipu/glm-5.3-flash");
  assert.equal(req.cwd, "E:/tmp/wt-1");
  assert.deepEqual(req.outputSchema, { type: "object" });
  assert.equal(req.signal, ac.signal);
});

test("桥接: usage 缺省（cancelled）不触发 onUsage、不冒充 0", async () => {
  const { runner } = makeRunner({
    default: { status: "cancelled", output: { type: "text", value: "" }, sessionId: "s" },
  });
  let called = false;
  await assert.rejects(runner.run("hi", { onUsage: () => (called = true) }));
  assert.equal(called, false);
});
