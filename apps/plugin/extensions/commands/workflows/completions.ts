/**
 * /workflows 参数补全（getArgumentCompletions，宿主 Tab 触发）。
 *
 * 按位置分级：
 *   - 子命令名：全部子命令按前缀过滤（含同义别名）
 *   - run/register|reg 后：注册表 workflowId（含内置；脚本路径不补全——目录枚举过泛，直接粘贴即可）
 *   - unregister|unreg 后：只补项目注册条目（内置不可注销，不该出现在候选里）
 *   - watch/status/cancel|stop 后：RunManager 里的 runId（在途 + 最近终态，带状态描述）
 *
 * 契约（宿主 CombinedAutocompleteProvider）：prefix 是**整段参数文本**（不含命令名本身），
 * 选中补全项时宿主用 item.value **整段替换** prefix（beforePrefix + value + afterCursor），
 * 只把 item.label 当展示文本。因此 value 必须是完整参数串（如 "unreg smoke_test"），
 * 返回裸 token（"smoke_test"）会把已输入的 unreg/run 一起顶掉——这是 2026-11-20 的线上 bug。
 * 子命令项 value 带尾随空格，便于 Tab 后继续补第二个参数（与宿主内置 /mcp 补全同款）。
 *
 * 纯函数，可测；注册表读取失败时返回空表（补全是输入辅助，不因坏脚本阻塞打字）。
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui"
import { loadRegistry } from "../../../../../packages/engine/src/runtime/workflow-registry.js"
import type { RunManager } from "../../../../../packages/manager/src/run-manager.js"

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

/** 带位置前缀的补全项：value 为完整参数串（宿主整段替换用），label 仅展示 */
function argItem(value: string, label: string, description: string): AutocompleteItem {
  return { value, label, description }
}

export function completeWorkflowsArgs(prefix: string, deps: CompletionDeps): AutocompleteItem[] {
  const tokens = prefix.split(/\s+/).filter(Boolean)
  const endsWithSpace = /\s$/.test(prefix)
  const head = tokens[0] ?? ""

  // 位置 1：还没敲空格 → 仍在输入子命令名。
  // 判定只看「是否已敲空格 / 是否只有首 token」，不能以「是否等于已知子命令」判定，
  // 否则敲完 unreg/run 但没空格时会提前跳到位置 2 返回 workflowId。
  if (!endsWithSpace && tokens.length <= 1) {
    return KNOWN_SUBCOMMANDS.filter((k) => k.startsWith(head)).map((k) =>
      argItem(`${k} `, k, SUB_DESCRIPTIONS[k]),
    )
  }

  const partial = endsWithSpace ? "" : (tokens[1] ?? "")
  try {
    switch (head) {
      case "run":
      case "reg":
      case "register":
      case "unreg":
      case "unregister": {
        const unregistering = head === "unreg" || head === "unregister"
        const entries = Array.from(loadRegistry(deps.cwd).values())
        return entries
          .filter((wf) => (unregistering ? !wf.builtin : true))
          .filter((wf) => wf.id.startsWith(partial))
          .map((wf) =>
            argItem(`${head} ${wf.id}`, wf.id, wf.builtin ? "内置工作流（执行）" : `项目工作流（${unregistering ? "注销" : "执行/注册"}）`),
          )
      }
      case "watch":
      case "status":
      case "cancel":
      case "stop": {
        return deps.runManager
          .list()
          .filter((r) => r.runId.startsWith(partial))
          .map((r) =>
            argItem(
              `${head} ${r.runId}`,
              r.runId,
              `${r.status}${r.label ? ` ${r.label}` : ""} agents=${r.agents}`,
            ),
          )
      }
    }
  } catch {
    // 注册表读取失败（坏脚本等）：补全降级为空，不在输入框阻塞用户
    return []
  }
  return []
}
