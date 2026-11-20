/**
 * /workflows 参数补全（getArgumentCompletions，宿主 Tab 触发）。
 *
 * 按位置分级：
 *   - 子命令名：全部子命令按前缀过滤（含同义别名）
 *   - run/register|reg 后：注册表 workflowId（脚本路径不补全——目录枚举过泛，直接粘贴即可）
 *   - unregister|unreg 后：注册表 workflowId
 *   - watch/status/cancel|stop 后：RunManager 里的 runId（在途 + 最近终态，带状态描述）
 *
 * 纯函数，可测；注册表读取失败时返回空表（补全是输入辅助，不因坏脚本阻塞打字）。
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui"
import { loadRegistry } from "../../../src/engine/runtime/workflow-registry.js"
import type { RunManager } from "../../../src/manager/run-manager.js"

const SUB_DESCRIPTIONS: Record<string, string> = {
  list: "列出注册表工作流与最近运行",
  run: "后台执行脚本",
  status: "查看运行详情",
  cancel: "停止运行",
  stop: "停止运行（cancel 同义）",
  register: "注册工作流",
  reg: "注册工作流（register 同义）",
  unregister: "注销工作流",
  unreg: "注销工作流（unregister 同义）",
  ui: "打开 Navigator 全屏面板",
  watch: "单 run 专注视图",
}

const KNOWN_SUBCOMMANDS = Object.keys(SUB_DESCRIPTIONS)

export interface CompletionDeps {
  runManager: RunManager
  cwd: string
}

export function completeWorkflowsArgs(prefix: string, deps: CompletionDeps): AutocompleteItem[] {
  const tokens = prefix.split(/\s+/).filter(Boolean)
  const endsWithSpace = /\s$/.test(prefix)
  const head = tokens[0] ?? ""

  // 位置 1：还没敲空格 → 仍在输入子命令名。
  // 注意不能以「是否等于已知子命令」判定：否则敲完 unreg/run 但没空格时，补全会直接
  // 跳到位置 2 返回 workflowId，宿主接受补全项时把整段参数替换掉（表现为 unreg 被“吃掉”）。
  if (!endsWithSpace && tokens.length <= 1) {
    return KNOWN_SUBCOMMANDS.filter((k) => k.startsWith(head)).map((k) => ({
      value: k,
      label: k,
      description: SUB_DESCRIPTIONS[k],
    }))
  }

  const partial = endsWithSpace ? "" : (tokens[1] ?? "")
  try {
    switch (head) {
      case "run":
      case "reg":
      case "register":
      case "unreg":
      case "unregister": {
        const verb = head === "unreg" || head === "unregister" ? "注销" : "执行/注册"
        return Array.from(loadRegistry(deps.cwd).keys())
          .filter((id) => id.startsWith(partial))
          .map((id) => ({ value: id, label: id, description: `注册表工作流（${verb}）` }))
      }
      case "watch":
      case "status":
      case "cancel":
      case "stop": {
        return deps.runManager
          .list()
          .filter((r) => r.runId.startsWith(partial))
          .map((r) => ({
            value: r.runId,
            label: r.runId,
            description: `${r.status}${r.label ? ` ${r.label}` : ""} agents=${r.agents}`,
          }))
      }
    }
  } catch {
    // 注册表读取失败（坏脚本等）：补全降级为空，不在输入框阻塞用户
    return []
  }
  return []
}
