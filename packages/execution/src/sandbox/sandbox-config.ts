/**
 * Sandbox 配置生成（M2.0/M2.2）—— 把执行请求编译成 SRT 配置
 *
 * 安全基线（保守默认，fail-closed）：
 *   文件系统：写入 = 仅工作区（显式允许模式）；读取 = 默认允许，但凭据目录显式 denyRead
 *             （SRT 语义：读取默认放开，不 denyRead 就等于全可读——见评审提醒）
 *   网络：strictAllowlist + allowedDomains 为空 = 默认全部拒绝
 *   凭据：环境变量按名拒绝（能注入任意命令的变量）
 *   路径：全部规范化绝对路径（SRT 在 macOS/Linux 对路径匹配处理不一致，Linux 用具体路径而非 glob）
 *
 * 平台：darwin / linux 生成配置；win32 由调用方在更早层拒绝（不依赖 SRT 的 isSupportedPlatform，
 * 0.0.81 的 Windows Alpha 后端对 windows 也返回 true，但本项目策略仍为 unsupported）。
 */

import { realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"

/** 凭据目录（家目录相对）：沙盒内一律不可读 */
export const CREDENTIAL_DIRS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".config/gcloud",
  ".netrc",
  ".pgpass",
  ".npmrc",
] as const

/** 能向子进程注入任意命令/代码的环境变量：一律不进沙盒 */
export const DENIED_ENV_VARS = [
  "JAVA_TOOL_OPTIONS",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
] as const

export interface SandboxPolicyInput {
  /** 工作区根（可写边界）：相对路径会按 cwd 解析，最终规范化为绝对真实路径 */
  workspace: string
  /** 额外允许访问的域名（缺省空 = 网络全拒） */
  allowedDomains?: readonly string[]
}

/** 规范化绝对路径：解析相对路径 + 消解 symlink（工作区不存在时退回 resolve 结果） */
export function normalizeAbsolute(target: string, base = process.cwd()): string {
  const absolute = path.isAbsolute(target) ? target : path.resolve(base, target)
  try {
    return realpathSync.native(absolute)
  } catch {
    return path.normalize(absolute)
  }
}

/** 家目录下的凭据目录 -> 绝对路径列表（存在与否都列出：不存在时 deny 无害，存在时生效） */
export function credentialDenyReadPaths(home = os.homedir()): string[] {
  return CREDENTIAL_DIRS.map((dir) => path.join(home, dir))
}

/**
 * 生成 SRT 配置。
 * 注意：filesystem.allowWrite 是显式允许模式（不在列表里的路径写不进去）；
 * filesystem.denyRead 是读取的补充限制（SRT 默认允许读取）。
 */
export function buildSandboxConfig(input: SandboxPolicyInput): SandboxRuntimeConfig {
  const workspace = normalizeAbsolute(input.workspace)
  const home = os.homedir()
  const config = {
    network: {
      allowedDomains: [...(input.allowedDomains ?? [])],
      deniedDomains: [],
      // 空 allowlist + strictAllowlist = 默认拒绝一切网络
      strictAllowlist: true,
    },
    filesystem: {
      // 写入边界：仅工作区（绝对路径 + literal，避免 glob 语义差异）
      allowWrite: [{ path: workspace, literal: true as const }],
      // 读取限制：凭据目录一律不可读（家目录内的诊断日志目录同样排除）
      denyRead: [
        ...credentialDenyReadPaths(home).map((p) => ({ path: p, literal: true as const })),
      ],
      allowRead: [],
      denyWrite: [],
      allowGitConfig: false,
    },
    credentials: {
      // 按名拒绝：这些变量能把任意命令/代码注入沙盒内的子进程
      envVars: DENIED_ENV_VARS.map((name) => ({ name, mode: "deny" as const })),
    },
  }
  return config as unknown as SandboxRuntimeConfig
}

/** 平台是否支持本项目沙盒（Windows 明确不支持：不降级宿主执行） */
export function sandboxPlatformSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "linux"
}
