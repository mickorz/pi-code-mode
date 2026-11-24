// Deterministic Mock Adapter: AgentAdapter 契约的确定性实现（不调 LLM）
// 作为 M1 PiAgentAdapter 的契约测试靶子; 脚本化返回预置 AgentResult
import type { AgentRequest, AgentResult } from "../../packages/adapter/src/types.js";

export interface MockScript {
  /** 按 executionId 匹配的预置返回; 未命中走 default */
  default?: Omit<AgentResult, "sessionId">;
  byExecutionId?: Record<string, Omit<AgentResult, "sessionId">>;
  /** execute 延迟 ms（模拟在途, 供 cancel/timeout 测试） */
  latencyMs?: number;
}

export class MockAgentAdapter {
  readonly calls: Array<{ request: AgentRequest; ctx: { executionId: string } }> = [];
  readonly cancelled: string[] = [];
  private script: MockScript;
  private settled = new Set<string>();

  constructor(script: MockScript = {}) {
    this.script = script;
  }

  async execute(request: AgentRequest, ctx: { executionId: string }): Promise<AgentResult> {
    this.calls.push({ request, ctx });
    // 契约行为: signal 中止时返回 cancelled 终态（对齐 PiAgentAdapter 的取消语义）
    if (request.signal?.aborted) {
      return { status: "cancelled", output: { type: "text", value: "" }, sessionId: `mock-${ctx.executionId}` };
    }
    if (this.script.latencyMs) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.script.latencyMs);
        request.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (request.signal?.aborted) {
        return { status: "cancelled", output: { type: "text", value: "" }, sessionId: `mock-${ctx.executionId}` };
      }
    }
    const preset = this.script.byExecutionId?.[ctx.executionId] ?? this.script.default;
    if (!preset) throw new Error(`Mock script missing entry for ${ctx.executionId}`);
    if (this.settled.has(ctx.executionId)) {
      // 同一 executionId 不得二次 settle（契约: cancel 后 execute 仍须返回终态, 但只返回一次记录）
      return { ...preset, sessionId: `mock-${ctx.executionId}` };
    }
    this.settled.add(ctx.executionId);
    return { ...preset, sessionId: `mock-${ctx.executionId}` };
  }

  async cancel(executionId: string): Promise<void> {
    this.cancelled.push(executionId);
    // 契约: 幂等, 未知 id 静默成功, 不抛
  }
}
