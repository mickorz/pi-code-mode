/**
 * 命令风险分析（M1 保守文本级；M3 按计划再评估 tree-sitter）
 *
 * 原则：识别即 deny（危险清单），识别不了不猜（走 executor，M1 executor fail-closed）。
 * 宁可误拦不可漏拦：黑名单覆盖不可逆破坏、提权、管道执行、凭据面。
 */

import { isProtectedPath } from "./protected-paths.js"

/** 只读程序白名单（M3 用于自动放行判定；M1 供展示与测试） */
export const READONLY_PROGRAMS: readonly string[] = [
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "stat", "file", "which",
  "pwd", "echo", "date", "whoami", "uname", "env", "printenv", "git status",
  "git diff", "git log", "git show", "git branch", "node --version", "npm ls",
  "python --version", "python3 --version",
]

interface DangerousRule {
  /** 原因码 */
  reason: string
  /** 危险模式（对命令全文做正则匹配） */
  pattern: RegExp
}

/**
 * 危险命令规则（M1 保守集）。
 * 每条规则注释说明拦的是什么，新增规则必须有对应测试。
 */
const DANGEROUS_RULES: readonly DangerousRule[] = [
  // rm 递归强制删系统根/家目录（rm -rf / 或 /* 变体）
  { reason: "rm_root", pattern: /\brm\s+[^;|&]*-[^-]*[rf][^;|&]*\s+(\/|~|\$HOME)(\/|\s|$)/ },
  // fork 炸弹（含 :(){ :|:& };: 与变形）
  { reason: "fork_bomb", pattern: /:\(\)\s*\{.*\|.*&.*\}\s*;?\s*:/ },
  // 文件系统级破坏
  { reason: "filesystem_wipe", pattern: /\b(mkfs(\.\w+)?|fdisk|parted|wipefs)\b/ },
  // dd 直写块设备（of=/dev/sd* 等；of 后跟设备目标）
  { reason: "dd_device", pattern: /\bdd\b[^;|&]*\bof=\/dev\/(sd|nvme|hd|disk|mapper)/ },
  // 提权（sudo/su 交给审批体系前一律拒绝；M1 无审批 UI）
  { reason: "privilege_escalation", pattern: /(^|\s|;|&&|\|\|)(sudo|doas|su)\s/ },
  // 电源与内核
  { reason: "system_power", pattern: /\b(shutdown|reboot|halt|poweroff|init\s+[066])\b/ },
  // 管道执行远程内容（curl/wget | sh/bash/python）
  { reason: "pipe_to_shell", pattern: /\b(curl|wget|fetch|nc|ncat)\b[^;|&]*\|\s*(sudo\s+)?(sh|bash|zsh|python\d?|perl)\b/ },
  // 反弹 shell
  { reason: "reverse_shell", pattern: /\b(bash|sh|zsh)\s+-[ic]\s+['"][^'"]*\b(dev\/tcp|nc |ncat |bash -i)/ },
  // chmod -R 777 到根（全局权限破坏）
  { reason: "chmod_root", pattern: /\bchmod\s+[^;|&]*-R[^;|&]*\s+777\s+(\/|~)(\s|$)/ },
  // 写向系统设备（> /dev/sda 等）
  { reason: "redirect_device", pattern: />\s*\/dev\/(sd|nvme|hd|disk|mapper|mem|kmem)/ },
  // 覆盖 shell 配置（持久化驻留面：.bashrc/.zshrc/.profile）
  { reason: "shell_rc_overwrite", pattern: />\s*>{0,1}\s*~?\/?\.(bashrc|zshrc|profile|bash_profile)\b/ },
  // chmod +x 到 ssh 私钥 / authorized_keys 写入（凭据面）
  { reason: "credential_tamper", pattern: /(>\s*|cp\s+\S+\s+|mv\s+\S+\s+).*((id_rsa|id_ed25519)|authorized_keys|\.ssh\/)/ },
  // Git 钩子注入（core.hooksPath 指向可写目录）
  { reason: "git_hook_injection", pattern: /git\s+config\s+[^;|&]*core\.hooksPath/ },
  // 环境注入通道（LD_PRELOAD 写入场景，与 JAVA_TOOL_OPTIONS 同类）
  { reason: "env_injection", pattern: /\b(LD_PRELOAD|JAVA_TOOL_OPTIONS|GIT_CONFIG_COUNT)\s*=/ },
]

export interface CommandAnalysis {
  /** 命中危险规则的原因码；undefined 表示未命中 */
  dangerousReason?: string
  /** 首个识别到的只读程序（供展示） */
  readonlyProgram?: string
  /** 命令文本中出现的受保护路径 */
  protectedPath?: string
}

/** 文本中的路径候选（粗提取：绝对路径、~/ 开头、.ssh 等凭据目录形态） */
function extractPathCandidates(command: string): string[] {
  const matches = command.match(/(?:[A-Za-z]:)?(?:\/|~\/)[^\s;|&<>]+/g) ?? []
  const cred = command.match(/\.[a-z]+\/[a-z]/gi) ?? []
  return [...matches, ...cred]
}

export function analyzeCommand(command: string): CommandAnalysis {
  for (const rule of DANGEROUS_RULES) {
    if (rule.pattern.test(command)) {
      return { dangerousReason: rule.reason }
    }
  }
  const paths = extractPathCandidates(command)
  const protectedHit = paths.find((p) => isProtectedPath(p))
  if (protectedHit) {
    return { dangerousReason: "protected_path", protectedPath: protectedHit }
  }
  const readonlyProgram = READONLY_PROGRAMS.find((program) => command.startsWith(program))
  return readonlyProgram ? { readonlyProgram } : {}
}

/** 便捷判定：命令是否危险（deny 依据） */
export function isDangerousCommand(command: string): boolean {
  return analyzeCommand(command).dangerousReason !== undefined
}
