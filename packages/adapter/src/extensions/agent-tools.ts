/**
 * agent-tools —— 受控工具层：替代 pi 内置 read/bash/edit/write（M1）
 *
 * 每个工具的 execute 先消费 Permit（第二阶段防线），再走唯一执行出口：
 *   文件工具 -> WorkspaceFileService（path-boundary 强制工作区边界）
 *   命令工具 -> CommandExecutor（M1 默认 fail-closed；M2 接 SRT 沙盒）
 * Permit 校验失败 = 拒绝执行（含 SDK 静默放行错误形态的场景，M0.1 实证）。
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { ControlledExtensionDeps } from "./types.js"

export function createAgentToolsExtension(deps: ControlledExtensionDeps) {
  const factory = (pi: ExtensionAPI): void => {
    /** 第二阶段防线包装：无有效 Permit 一律拒绝真实执行；signal 贯通到执行层（M1.1） */
    const guarded = (
      name: string,
      handler: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
      ) => Promise<{ text: string }>,
    ): ToolDefinition => ({
      name,
      label: name,
      description:
        name === "run_command"
          ? "在沙盒中执行 shell 命令（工作区为可写边界，网络默认拒绝）"
          : `${name}：工作区内的文件操作`,
      parameters: Type.Object({
        ...(name === "read_file" ? { path: Type.String() } : {}),
        ...(name === "write_file" ? { path: Type.String(), content: Type.String() } : {}),
        ...(name === "edit_file" ? { path: Type.String(), oldText: Type.String(), newText: Type.String() } : {}),
        ...(name === "run_command" ? { command: Type.String(), timeoutMs: Type.Optional(Type.Number()) } : {}),
      }),
      // SDK 契约：execute(toolCallId, params, signal, onUpdate, ctx)——第三参即会话级 AbortSignal
      // （Engine abort -> session.abort -> 工具执行 signal），M2 起一路贯通到 Sandbox Host 进程组
      execute: async (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => {
        if (!deps.permits.consume(toolCallId, name, params)) {
          deps.onPermitDenied?.({ toolName: name, toolCallId })
          return {
            content: [{ type: "text", text: `permit denied：${name} 调用未持有有效一次性许可，已拒绝执行（双阶段防线第二层）` }],
            details: undefined,
          }
        }
        const outcome = await handler(toolCallId, params, signal)
        return { content: [{ type: "text", text: outcome.text }], details: undefined }
      },
    })

    pi.registerTool(
      guarded("read_file", async (_id, params, signal) => {
        const text = await deps.files.read(String(params.path), signal)
        return { text }
      }),
    )
    pi.registerTool(
      guarded("write_file", async (_id, params, signal) => {
        await deps.files.write(String(params.path), String(params.content), signal)
        return { text: `written: ${String(params.path)}` }
      }),
    )
    pi.registerTool(
      guarded("edit_file", async (_id, params, signal) => {
        const outcome = await deps.files.edit(String(params.path), String(params.oldText), String(params.newText), signal)
        return { text: `edited: ${outcome.path}（1 处替换）` }
      }),
    )
    pi.registerTool(
      guarded("run_command", async (toolCallId, params, signal) => {
        const result = await deps.executor.execute({
          command: String(params.command),
          cwd: deps.files.root,
          timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
          signal, // M1.1：Engine abort -> session.abort -> 此处 -> Sandbox Host（M2 进程组终止）
          runId: deps.runId,
          executionId: deps.executionId,
          toolCallId,
        })
        if (result.blocked) {
          return { text: `blocked: ${result.blockReason ?? "command_blocked"}` }
        }
        const parts = [`exitCode: ${result.exitCode ?? "null"}`]
        if (result.stdout) parts.push(`stdout:\n${result.stdout}`)
        if (result.stderr) parts.push(`stderr:\n${result.stderr}`)
        if (result.timedOut) parts.push("timedOut: true")
        return { text: parts.join("\n") }
      }),
    )
  }
  return factory
}
