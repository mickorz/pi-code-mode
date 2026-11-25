/**
 * policy-extension —— 第一阶段授权：tool_call 事件 -> Policy Gate -> 签发 Permit / block
 *
 * 工程原则（执行计划 v3）：事件回调不是唯一防线——即使本 handler 返回错误形态被
 * SDK 静默放行（M0.1 实证），未签发 Permit 的调用也会被 agent-tools 的第二层拦截。
 * 返回值严格使用 ToolCallEventResult { block, reason }，禁止任何类型强转。
 */

import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent"
import { evaluateToolCall } from "../../../policy-lite/src/index.js"
import type { ControlledExtensionDeps } from "./types.js"

export function createPolicyExtension(deps: ControlledExtensionDeps) {
  const factory = (pi: ExtensionAPI): void => {
    pi.on("tool_call", (event: ToolCallEvent) => {
      let decision: ReturnType<typeof evaluateToolCall>
      try {
        decision = evaluateToolCall(
          { toolName: event.toolName, input: event.input, cwd: deps.files.root },
          deps.policy ?? {},
        )
      } catch (e) {
        // Policy 异常 fail-closed：不签发 Permit，直接 block
        return { block: true, reason: `policy_error:${String((e as Error)?.message ?? e)}` }
      }
      if (decision.decision === "deny") {
        return { block: true, reason: `policy_denied:${decision.reason}` }
      }
      if (decision.decision === "ask") {
        // M1 headless 无审批 UI：ask 一律 fail-closed（M3 引入审批后再放开）
        return { block: true, reason: "policy_ask_unavailable" }
      }
      // allow：签发一次性 Permit（第二阶段防线凭据）。不修改 event.input。
      deps.permits.issue(event.toolCallId, event.toolName, event.input)
      return undefined
    })
  }
  return factory
}
