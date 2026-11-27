/**
 * CommandExecutor —— Agent 命令执行的唯一出口接口（M1 冻结）
 *
 * 执行计划 v3 / D4：底层使用 @anthropic-ai/sandbox-runtime，一命令一 Sandbox Host
 * 进程（SRT 模块级单例，多命令共用会配置串扰——PiBot 实测结论）。
 * M1 只有接口与 fail-closed 默认实现；真实沙盒执行在 M2 落地。
 * 硬规则：禁止任何"宿主机直接执行"的临时旁路实现。
 */

export interface SandboxCommandRequest {
  command: string
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
  /** 其他工作区根（禁读禁写）：跨项目隔离，由工作区注册表或调用方提供 */
  denyWorkspaces?: readonly string[]
  /** 允许访问的域名（缺省空 = 网络全拒）；由策略层按命令注入 */
  allowedDomains?: readonly string[]
  /**
   * 额外的**只读**工具链路径（如 D:\CocosSofts\Creator.7.3）。
   * 必须由 Runtime/项目配置提供，**不得来自模型输入**——否则模型可自行声明任意可读路径。
   */
  readOnlyPaths?: readonly string[]
  /**
   * 额外的**可写**路径（编辑器缓存/日志目录等）。
   * 同样必须由 Runtime/项目配置提供，**不得来自模型输入**；仅限"构建专用权限档"使用。
   */
  writePaths?: readonly string[]
  /**
   * 受控面执行的**per-call 审批**回调：由我们的受控工具（agent-tools）注入，
   * 内部走 ctx.ui.confirm；print/headless 模式无 UI → 返回 false → fail-closed。
   * **只允许可信扩展设置**（模型输入不经过这里）。
   */
  approve?: (info: { command: string; cwd: string; reason: string }) => Promise<boolean>
  /** 执行身份贯通（runId/executionId 全链路关联，审计用） */
  runId?: string
  executionId?: string
  toolCallId?: string
}

export interface SandboxCommandResult {
  /** 沙盒内命令退出码；null = 未运行（被拦/信号终止/超时杀） */
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut?: boolean
  /** 执行层拦截（区别于命令自身的非零退出） */
  blocked?: true
  blockReason?: string
}

export interface CommandExecutor {
  execute(request: SandboxCommandRequest): Promise<SandboxCommandResult>
}

/**
 * M1 默认实现：拒绝一切真实执行（fail-closed）。
 * 沙盒未就绪期间 Agent 的 run_command 得到明确的 blocked 结果而非静默宿主执行；
 * M2 由 SrtCommandExecutor 替换，测试注入 Mock 验证管线。
 */
export class UnavailableCommandExecutor implements CommandExecutor {
  private readonly reason: string

  constructor(reason = "sandbox_not_available") {
    this.reason = reason
  }

  async execute(): Promise<SandboxCommandResult> {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      blocked: true,
      blockReason: `${this.reason}：命令执行通道未就绪（M2 接入 Sandbox Runtime），已拒绝宿主机执行`,
    }
  }
}
