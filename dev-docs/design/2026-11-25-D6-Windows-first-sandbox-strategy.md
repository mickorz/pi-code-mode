# D6 决策修订：Windows-first Sandbox Strategy

> 修订日期：2026-11-25
> 取代：原 D6「平台策略：macOS/Linux 优先，Windows explicit unsupported」
> 触发：项目平台战略澄清——Windows 是核心运行环境，Sandbox 是核心能力，不是可选兼容项

## 1. 背景

原 D6 把 Windows 定位为"明确不支持，拒绝优先"，理由是 SRT 无成熟 Windows 后端。该决策的安全逻辑正确，**但产品逻辑错误**：pi-code-mode 的核心用户环境是 Windows，Windows 上无法执行命令意味着核心能力缺失。macOS/Linux 的验证不能替代 Windows 的真实 OS 级隔离。

## 2. 新决策

| 平台 | 定位 | 优先级 |
|---|---|---|
| Windows | **核心目标平台**，必须具备真实 OS 级 Sandbox | **P0** |
| macOS | SRT Seatbelt 参考验证 | P2 |
| Linux | SRT bubblewrap 补充验证 | P2 |

### 决策条款

1. Windows 原生 Sandbox 为 **P0**；macOS/Linux 不得替代其验证。
2. 首选评估 Anthropic Sandbox Runtime 的 `srt-win` 后端。
3. 不因上游 Alpha 标签直接放弃，但**必须通过独立安全验证**（M2-W0）。
4. 优先评估 **SRT 0.0.83**（已实测升级，见第 4 节），显式 `windows.backend: 'srt-win'`，**不启用 MXC**（避免同时引入两套 Windows 沙盒技术）。
5. 安装验证在**隔离 Windows 测试环境**（Win11 VM + 快照）进行，不首轮改日常开发主机。
6. **不默认授予** Profile Read 权限（安装用 `--skip-profile-grant`），后续只显式开放实际需要的工具目录。
7. **不允许宿主机执行降级**（不变）。
8. Windows 后端未通过 M2-W0 验收前，`CommandExecutor` 在 win32 保持 **fail-closed**（`isolation_unavailable`）。
9. SRT Windows 若不满足安全要求，再评估 MXC / WSL2 / Docker，三者不同时开发。

## 3. 执行顺序（Windows-first）

| 阶段 | 内容 |
|---|---|
| **M2-W0** | Windows SRT 可行性验证（隔离 VM、12 项矩阵、工具兼容性、Go/No-Go） |
| M2-W1 | Windows Sandbox Host 实现（已部分完成：Host 协议 + spawnSandboxed） |
| M2-W2 | 文件与网络权限验证 |
| M2-W3 | AbortSignal、超时、进程树回收 |
| M2-W4 | 并行执行、跨 Session 隔离 |
| M2-W5 | 接入 PiAgentAdapter / Workflow CommandExecutor |

原 M2.0（Mac 首验）/ M2.4（Linux 补测）降级为 P2，待 Windows 结论后执行。

## 4. SRT 版本比对结论（0.0.81 → 0.0.83）

实测比对（本地解包 diff `dist/**/*.d.ts`）：

| 维度 | 结论 |
|---|---|
| 破坏性变更 | **无**。`index.d.ts` 导出为纯增量 |
| 新增导出 | `WindowsBackendSelection`、`SandboxedProcess`、`SpawnSandboxedOptions`、`SandboxInitializeConflictError`、`WindowsProfileForgetResult`、`CheckDependenciesOptions`、MXC 系列（`MxcSdk`/`MxcRequest`/`MxcProbeOutput`/`MxcProcessHandle`/`MxcUiCapabilities`） |
| 关键 API 增益 | **`SandboxManager.spawnSandboxed(command, opts): Promise<SandboxedProcess>`** —— 原生 `kill()`（杀命令及其派生全部进程）、`wait()`（`exitCode` + `timedOut`）、内建 `timeoutMs`。取代我们手写 wrapWithSandbox + spawn + 进程组 kill |
| 配置增益 | `windows.backend: 'srt-win' \| 'mxc'`；0.0.82 收窄 Profile Read Grant |
| 引擎要求 | 均 `node >= 22.12.0`（本机 v24.18.0 满足） |
| 项目适配 | 升级后 `tsc --noEmit` 零错误；contract 285/0、engine 222/0、Windows 验证 8/8 不变 |

**最终固定版本：`@anthropic-ai/sandbox-runtime@0.0.83`**（精确固定，不用浮动版本）。

## 5. 已知安全残余（必须登记，不得当普通 warning 忽略）

来自上游 README/文档，M2-W0 必须实测确认对威胁模型的影响：

| # | 残余 | 影响 | 验证方式 |
|---|---|---|---|
| R1 | Anonymous Token 可绕过部分 WFP 网络过滤 | 网络隔离可能不完整 | `m2-w0-check.ts` W5/W7：直连互联网必须被拒 |
| R2 | 派生的受限 Token 存在网络过滤盲区 | 同上 | 同上 |
| R3 | 系统服务代发流量不受同等过滤约束 | 可经服务代理外联 | 需专门构造（M2-W2） |
| R4 | SMB 流量不依赖域名白名单 | 白名单不覆盖 UNC | 需构造 UNC 访问（M2-W2） |
| R5 | 部分 residual 上报但不导致初始化失败 | 可能静默降级 | 检查 `checkDependencies` + initialize 返回值，M2-W0 记录 |
| R6 | Profile Read Grant 可能暴露 `.npmrc`/NuGet/Maven 私有仓库凭据 | 凭据泄漏 | 安装用 `--skip-profile-grant`（决策条款 6） |
| R7 | Windows `allowRead`/`allowWrite` 是 **Session 级**，`wrapWithSandbox` 的 `customConfig` 不能覆盖单命令授权；`allowWrite` 根可能跨 Session 保留 | 项目间隔离可能失效 | W11/W12：并行项目写不串扰 + 跨 Session 读符合策略 |

**R7 直接挑战「一命令一 Host」的隔离语义**——Windows 上不是每命令独立授权，而是 Session 级。这是 M2-W0 必须给出明确结论的一项。

## 6. 验收原则

1. 必须在 Windows 原生环境完成真实 OS 隔离测试。
2. **不得用 Mock、模型自述或配置检查代替真实隔离证明**。
3. 所有已知 residual 必须登记，并按威胁模型决定是否允许发布。
4. Windows 是首个正式验收平台；macOS/Linux 为后续适配平台。

## 7. 当前状态（2026-11-25）

- SRT 已升级并固定 `0.0.83`；Host 改用 `spawnSandboxed`（原生进程树回收）。
- `windows.backend: 'srt-win'` 配置支持与 opt-in 开关已实现（`SrtCommandExecutor({ windowsBackend })` / `createCommandExecutor({ windowsBackend })`）。
- **win32 默认仍 fail-closed**（未通过 M2-W0 前不开放）。
- 本机基线已采集：无 `srt-sandbox` 用户、0 条 WFP 过滤器、无 CA → **后端未安装**。
- 下一步：在隔离 Win11 VM 中执行 `windows-install --skip-profile-grant`，然后跑 `m2-w0-check.ts`。

---

## 8. M2-W0b 实测结论（2026-11-25，真实 Windows 环境）

### 8.1 重大发现：MXC BaseContainer 在本机直接可用

用 SRT 0.0.83 的 `windows.backend: 'mxc'` + `@microsoft/mxc-sdk@1.1.0` 实测：

```
tier: "base-container"                       ← 满足要求
baseContainerApiPresent: true
baseContainerSupportsDenyPaths: true         ← 能拒路径
baseContainerSupportsIdentitylessLoopbackProxy: true  ← 能收紧出口到代理
isolationSessionAvailable: true
warnings: []                                 ← 零告警
needsDaclAugmentation: false
```

**不需要 UAC 安装、不需要创建 srt-sandbox 用户、不需要 WFP 过滤器、不需要 CA、不需要 VM。**
这验证了 MXC 优先于 srt-win 的判断。

### 8.2 边界实测矩阵（13 PASS / 2 WARN / 0 FAIL）

用本项目 `SrtCommandExecutor({ windowsBackend: 'mxc' })` 端到端执行：

| 项 | 结果 | 证据 |
|---|---|---|
| W1 工作区内写入 | PASS | `exit=0`，文件落盘 `inside-ok` |
| **W2 工作区外写入** | **PASS（拒绝）** | `exit=1`，中文「拒绝访问」，外部文件未创建 |
| **W3 denyRead 秘密文件** | **PASS（拒绝）** | `exit=1`，未泄漏 `TOP_SECRET_TOKEN_12345` |
| W3b denyRead 目录枚举 | PASS | 未列出 `token.txt` |
| **W4 网络默认拒绝** | **PASS（拒绝）** | `curl: (7) CONNECT tunnel failed, response 403` |
| W5 超时终止 | PASS | `timedOut=true`，2724ms |
| W6 并行两工作区不串扰 | PASS | 无交叉文件 |
| TOOL CMD / PowerShell / Node / npm / Git / Python | 全部 PASS | 版本均正确输出 |
| TOOL Git Bash (MSYS2) | **WARN** | `exit=-1073741502`（STATUS_DLL_INIT_FAILED），确认不兼容 |
| W8 宿主机 `%TEMP%` 可写 | **WARN** | SRT 设计如此，见 8.3 |

### 8.3 两个必须登记的残余（WARN）

**R-TEMP：宿主机 `%TEMP%` 永远可写。**
根因在 SRT 源码 `mxc-sandbox-utils.js` `buildMxcRequest()`：

```js
const readwritePaths = [
    ...(p.allowWrite ?? []),
    ...(temp !== undefined ? [temp] : []),   // 宿主机 %TEMP% 无条件加入
];
```

影响：沙盒内命令可写 `%TEMP%` 下任意文件。缓解措施：
- 工作区不要放在 `%TEMP%`（我们的工作区是项目目录，不受影响）。
- 若威胁模型要求，可在 M2-W2 给 `denyWrite` 显式补 `%TEMP%` 子路径（需验证 MXC 的 deny 优先级）。

**R-Msys2：Git Bash / MSYS2 无法在 MXC 内启动**（`STATUS_DLL_INIT_FAILED`）。
影响：依赖 Git Bash 的命令（部分脚本、POSIX 语法）不可用。原生 `git.exe`、PowerShell、CMD、Node、Python 均正常。
缓解：Agent prompt 引导用 `cmd /c` 与 PowerShell；若确需 bash，评估 srt-win 或 WSL2 后端。

### 8.4 阻塞项：Node 版本

MXC 原生 stdio 要求 **Node 24.21.0+**（Node 24 线）或 **26.8.0+**（Node 26 线）。
本机默认 24.18.0 直接报 `MxcError ... native stdio on Windows requires Node.js 24.21.0 or newer`，`code: backend_unavailable`。

已处理：
- `mxcNodeVersionOk()` / `mxcNodeVersionHint()` 在 `sandbox-config.ts` 显式前置拦截，给出可操作提示而非裸 MxcError。
- 用本机已有的 **Node 26.11.1**（nvm 已安装）验证通过，未切换全局版本。

**待决策**：项目 Node 版本基线是否提到 `>=24.21.0`（建议 `.nvmrc` + `package.json engines`），因为 pi 宿主进程与其 spawn 的 Sandbox Host 继承同一 Node。

### 8.5 修复的两个真实 bug（本轮实测暴露）

1. **`--import` 传 Windows 绝对路径在 Node 26 报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`** —— 必须用 `file://` URL（`pathToFileURL(loaderPath).href`）。
2. **重写 executor 时丢失 `child.stdin.write(payload)`** —— Host 永远等 payload、父进程等 Host 退出，死锁到超时。已补回，并加 `PCM_SANDBOX_DEBUG=1` 阶段追踪便于定位。

### 8.6 判定

**CONDITIONAL-GO**：MXC BaseContainer 具备成为 Windows 正式执行底座的能力（文件/网络/进程三项核心隔离均实证有效）。
放行前需处理：
1. Node 版本基线提升到 24.21+（决策）。
2. Git Bash 不兼容需在产品层规避（prompt 引导 / 文档声明）。
3. `%TEMP%` 可写需按威胁模型决定是否加 denyWrite。
4. 仍需补测：白名单域名放行、跨 Session 读取（R7）、父 Host 崩溃回收、Cocos/构建类真实工具链。
