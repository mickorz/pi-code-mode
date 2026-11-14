/**
 * pi-code-mode extension 入口（pi package manifest 指向本文件）
 *
 * 流程：
 *   pi 加载本扩展 -> registerTool(workflow / workflow_control) -> 模型调用
 *     -> 取脚本（scriptPath 或 script 字面量） -> parseWorkflowScript 校验 meta
 *     -> PiAgentAdapter（全局并发闸包装） + agentAdapterToRunner 组装 runner
 *     -> runWorkflow 执行（journal 落盘 .pi/workflows/journal/） -> 渲染结果回传主会话
 *
 * RunManager 模块级单例：同进程多会话共享，workflow_control 可跨会话查询/取消。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { RunManager, withGlobalGate } from "../src/manager/run-manager.js"
import { PiAgentAdapter } from "../src/adapter/pi-agent-adapter.js"
import { loadRegistry } from "../src/engine/runtime/workflow-registry.js"
import { makeWorkflowTool, makeWorkflowControlTool, type WorkflowToolDeps } from "../src/tools/workflow-tools.js"

const runManager = new RunManager(16)

function makeDeps(cwd?: string): WorkflowToolDeps {
  return {
    runManager,
    // 全局并发闸：跨 run 兜底（run 级限流在 runtime 内，此处是全局第二道）
    adapterFactory: () => withGlobalGate(new PiAgentAdapter({ defaultCwd: cwd ?? process.cwd() }), runManager.gate),
    cwd,
  }
}

export default function extension(pi: ExtensionAPI): void {
  // 后台 run 完成回传主会话（M3 结果回传通道：pi.sendUserMessage）
  const deliver = async (text: string) => {
    try {
      await pi.sendUserMessage(text)
    } catch (e) {
      // 会话已关闭等场景：后台 run 仍继续（对齐 opencode 版"不 kill"语义），回传失败静默
      console.error("[pi-code-mode] 后台结果回传失败:", String((e as Error)?.message ?? e))
    }
  }

  pi.registerTool(makeWorkflowTool({ ...makeDeps(), deliver }) as any)
  pi.registerTool(makeWorkflowControlTool(makeDeps()) as any)

  // /workflows：列出注册表工作流与最近运行（M2）
  pi.registerCommand("workflows", {
    description: "列出已注册的 workflow 与最近运行状态",
    handler: async (_name: string, ctx: any) => {
      const cwd = ctx.cwd ?? process.cwd()
      const lines: string[] = []
      try {
        const registry = loadRegistry(cwd)
        if (registry.size) {
          lines.push(`已注册工作流（${registry.size}，目录 .pi/workflows/ 或兼容目录）:`)
          for (const [id, wf] of registry) lines.push(`  - ${id}  ${wf.meta?.description ?? ""}`)
        } else {
          lines.push("注册表为空（项目内未发现可注册的 workflow 脚本）")
        }
      } catch (e) {
        lines.push(`注册表读取失败: ${String((e as Error)?.message ?? e)}`)
      }
      const runs = runManager.list()
      lines.push("")
      lines.push(runs.length ? `最近运行（${runs.length}）:` : "最近无 workflow 运行")
      for (const r of runs) {
        lines.push(`  - ${r.status.padEnd(9)} ${r.runId}${r.label ? `（${r.label}）` : ""} agents=${r.agents}${r.error ? ` 错误: ${r.error.slice(0, 60)}` : ""}`)
      }
      ctx.ui.notify(lines.join("\n"), "info")
    },
  })
}
