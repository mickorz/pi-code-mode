# Windows Sandbox 正式验收报告

> 报告编号：AC-WIN-SANDBOX-001
> 日期：2026-11-25（证据重跑日期：2026-11-27）
> 平台：Windows 11（win32 x64，OS build 10.0.26300）
> 决策依据：`dev-docs/design/2026-11-25-D6-Windows-first-sandbox-strategy.md`（D6 修订：Windows-first）
> 结论：**CONDITIONAL PASS —— 批准用于「命令执行隔离 + 跨项目隔离」；不批准「GUI 构建链沙盒内执行」（改由受控面承载）；不批准宣称完整的用户目录隔离。**

---

## 1. 验收结论摘要

| 能力 | 验收结果 | 依据 |
|---|---|---|
| Windows 原生 OS 级命令隔离（文件写入边界） | **通过** | W0b W2 / W0c C2 |
| 敏感路径（凭据）读取隔离 | **通过** | W0b W3 / W0c C3 |
| 网络默认拒绝 + 域名白名单放行 | **通过** | W0c C4a / C4b |
| 进程生命周期（超时/取消/父进程崩溃回收） | **通过** | W0c C5 / C6 |
| 并行执行不串扰 | **通过** | W0c / W2 W2-06 |
| 跨项目读取隔离 | **通过** | W2（含 junction 绕过测试） |
| Runtime 统一权限决策（不可被 Agent 绕过） | **通过** | W2b E6 |
| 真实工程规模负载（732 文件 / 30.9MB） | **通过** | W3 R1 |
| GUI 构建链在沙盒内执行 | **不通过（平台限制）** | W3b §7.3 |
| GUI 构建链经受控面执行（审批+审计） | **通过** | W4 A2 / W4b |
| 完整用户目录隔离 | **未实现（不作承诺）** | §5.2 |

**放行范围**：Agent / Workflow 的命令执行在 Windows 上启用 MXC 沙盒（`windows.backend: 'mxc'`）为默认路径；沙盒无法承载的 GUI 构建命令经受控执行面（人工审批 + 审计）执行。
**不放行范围**：不得对外宣称"Windows 上所有进程都受隔离"、"用户目录完全隔离"、"GUI 应用在沙盒内可运行"。

## 2. 版本基线（精确固定）

| 组件 | 版本 | 说明 |
|---|---|---|
| `@anthropic-ai/sandbox-runtime` | **0.0.83**（精确） | 0.0.82 收窄 Profile Read Grant；0.0.83 新增 `spawnSandboxed` 与 `windows.backend` |
| `@microsoft/mxc-sdk` | **1.1.0**（精确） | SRT 的可选 peer 依赖，走 `@microsoft/mxc-sdk/v1` 的 `probe()` + `spawn()` |
| Node.js | **`^24.21.0 \|\| ^26.8.0`** | `.nvmrc` = 24.21.0；MXC 原生 stdio 硬要求，25.x / 27+ **不放行** |
| Windows | 11 build 10.0.26300 | MXC BaseContainer tier 探测为 `base-container` |
| 编辑器（受控面用） | Cocos Creator 3.7.3 @ `D:\CocosSofts\Creator\3.7.3` | 仅在受控面执行 |

**MXC 能力探测结果**（`checkWindowsSandboxStatusAsync` / `probe()`）：

```
tier: "base-container"                              ← 满足要求
baseContainerApiPresent: true
baseContainerSupportsDenyPaths: true
baseContainerSupportsEnumeratePaths: true
baseContainerSupportsIdentitylessLoopbackProxy: true
isolationSessionAvailable: true
warnings: []                                        ← 零告警
needsDaclAugmentation: false
```

## 3. 架构基线

```
Agent / Workflow
      │  提出执行请求（不知道其他工作区、无权决定权限）
      ▼
RoutedCommandExecutor ──── 调用前路由（无失败后降级）
      │                          │
      │ 命中控制面规则            │ 其余
      ▼                          ▼
ControlPlaneExecutor        SrtCommandExecutor
  人工审批(ctx.ui.confirm)     WorkspaceRegistry 取 deny 集合
  宿主执行 + JSONL 审计          │
      │                          ▼
      │                     Sandbox Host（一命令一进程）
      │                          │
      │                          ▼
      │                     Microsoft MXC BaseContainer
      ▼                          （文件边界 / 网络代理 / 进程树）
  审计落盘 .pi/workflows/audit/control-plane-<date>.jsonl
```

三条职责分离（不可混淆）：**Agent 提请求 / Runtime 决定权限 / Sandbox 强制执行**。

## 4. 验收证据矩阵（全部可复现）

复现环境：Node 26.11.1（`%LOCALAPPDATA%\nvm\v26.11.1\node.exe`）
复现命令：`"<node26>" --import ./node_modules/tsx/dist/loader.mjs dev-examples/mxc-probe/<script>.ts`

| 阶段 | 脚本 | 结果 | 关键证据 |
|---|---|---|---|
| M2-W0b 边界可行性 | `mxc-boundary.mjs` | 13 PASS / 2 WARN / 0 FAIL | 工作区外写拒绝、denyRead 秘密文件零泄漏、网络 403、超时回收、并行不串扰 |
| M2-W0c 安全收尾 | `m2-w0c-check.ts` | **17 PASS / 1 WARN / 0 FAIL** | TEMP 隔离（写宿主机 TEMP 被拒 exit=1）、白名单放行(200)/非白名单拒绝(403)、父 Host 强杀后标记行 10→10、AbortSignal 4→4 |
| M2-W2 注册表 | `m2-w2-check.ts` | **14 PASS / 0 WARN / 0 FAIL** | A 读 B 拒绝、B 关闭后仍拒绝、大小写/尾分隔符/嵌套/junction 绕过全部拦下、未登记目录 fail-closed |
| M2-W2b 接线 | `m2-w2b-wiring.ts` | **7 PASS / 0 WARN / 0 FAIL** | **E6：调用方传 `denyWorkspaces: []` 试图清空隔离 → 被忽略** |
| M2-W3 真实工程 | `m2-w3-check.ts` | **5 PASS / 3 WARN / 0 FAIL** | 732 文件 / 30.9MB 全量读，与宿主 `missing: 0`；产物写入；超时回收 |
| M2-W3b 真实构建 | `m2-w3b-real-build.ts` | 见 §5.1 | GUI 构建链在沙盒内不可行 |
| M2-W4 受控面 | `m2-w4-check.ts` | **6 PASS / 0 WARN / 0 FAIL** | **A2：真实 `cocoscli build` exit=0，产物 49 文件 = 沙盒外基线 49** |
| M2-W4b 审计 | `m2-w4b-audit-e2e.ts` | PASS | 拒绝 + 批准两条均落盘 JSONL，不含 stdout/stderr |

**单元/契约测试**（任何平台可跑，`npx tsx --test`）：

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `tests/contract/sandbox-m1.test.ts` | 26 | Permit 语义 / 危险命令 / 路径边界（含 TOCTOU 竞争窗口）/ UTF-8 |
| `tests/contract/sandbox-m2.test.ts` | 9 | 配置安全基线 / 平台拒绝 / fail-closed |
| `tests/contract/workspace-registry.test.ts` | 6 | 注册幂等 / 引用计数 / 路径归一 / 祖先排除 / fail-closed |
| `tests/contract/control-plane.test.ts` | 10 | 四条硬约束（含"沙盒失败绝不转控制面"） |
| `tests/contract/control-plane-audit.test.ts` | 5 | 按日分文件 / append-only / 50 条并发不交错 / 不含输出 / 写失败不阻断 |

**全量回归**：contract **306/0**、engine **222/0**、`npm run build` 零错误、插件真实加载 `pi -ne -e . -p "只回复 ok"` → `ok`。

## 5. 已知限制与残余风险（必须随产品文档披露）

### 5.1 GUI / Electron 应用无法在沙盒内启动（已定性，非缺陷）

**证据**（沙盒内，`readOnlyPaths` 已指向编辑器目录）：

| 探测 | 结果 |
|---|---|
| `type D:\...\3.7.3\version` | exit=0 → `13.1.4`（文件读取正常） |
| `dir D:\...\3.7.3` | exit=1 拒绝访问（目录枚举被拒） |
| `CocosCreator.exe --version` | exit=1 拒绝访问 |
| + `writePaths`（APPDATA/LOCALAPPDATA/.CocosCreator/.CocosDashboard） | exit=1 |
| + `--no-sandbox` / `--disable-gpu` / `--disable-gpu-sandbox` | 全部 exit=1 |

**定性**：MXC BaseContainer 的隔离设计不承载 GUI 进程启动（SRT 固定 `ui:{disable:false, clipboard:'none', allowInputInjection:false}`，容器具备 `canBlockGlobalUiNamespace` 等能力）。**不是权限不足，放宽权限无效。**
**处置**：GUI 构建链走受控执行面（§6）。

### 5.2 未登记目录不在保护范围

注册表只保护"被 pi-code-mode 作为工作区执行过的目录"。未登记过的普通宿主目录**不受**跨项目 deny 保护。
→ **不得宣称"整个用户目录完全隔离"**。

### 5.3 注册表不持久化

`WorkspaceRegistry` 为进程内内存态。进程重启后仅重新登记当前项目；此前登记的其他工作区身份丢失，跨项目 deny 范围随之缩小。
→ 若要求"重启后仍 deny 上次登记的项目"，需落盘（**未实现**）。

### 5.4 宿主机 `%TEMP%` 默认共享可写（已被 TEMP 隔离缓解）

SRT 的 `buildMxcRequest()` **无条件**把宿主机 `%TEMP%` 加入 `readwritePaths`。
**缓解**：Host 启动后先把自身 `TEMP/TMP/TMPDIR` 指向随机私有目录（`pcm-host-temp-<pid>-*`）再 initialize，退出删除；实测 A 写宿主机原 TEMP 被拒。
→ 残余：Host 启动到重设 TEMP 之间存在极短窗口，且 Host 自身运行环境的 TEMP 语义依赖实现细节。

### 5.5 部分控制台工具在 MXC 下无法加载

实测 `bash.exe` / MSYS2 / `find.exe` 在受限 Token 下 `DLL 初始化失败`（`0xC0000142`）。
**处置**：Git Bash 能力边界已写入 `run_command` 工具描述（Supported: cmd.exe / powershell.exe / pwsh.exe；Unsupported: bash.exe / sh.exe / MSYS2 / Git Bash）。沙盒内文本处理应使用 PowerShell 或 Node。

### 5.6 受控面命令不受 OS 隔离（明确的取舍）

`ControlPlaneExecutor` 在**宿主**执行命令，不经过 MXC。这是"GUI 构建链无法隔离"的必然取舍。
**缓解**：① 规则只从项目配置读（模型无法声明）② 必须人工审批（`ctx.ui.confirm` 展示 cwd + 命令前 400 字符）③ 全程审计落盘 ④ 结构性禁止静默降级。
**残余**：控制面命令的实际副作用等同于用户本人执行；审计是事后追溯，不是事前阻断。

### 5.7 规则文件属项目信任面

`.pi/workflows/control-plane.json` 被恶意修改可扩大受控面范围。该文件应与 `.pi/settings.json` 同级纳入代码评审。

### 5.8 无审批通道时 GUI 构建不可用（预期行为）

print / headless / 定时任务（routines）无 UI → 审批不可用 → 受控面命令 fail-closed 拒绝。属**预期**行为，不是缺陷。

### 5.9 尚未验证/未实现项

| 项 | 状态 |
|---|---|
| 白名单域名的 SNI/Host 逃逸攻击测试 | 未做（仅验证了放行/拒绝的基线路由） |
| 审计日志轮转与保留期 | 未实现（按日分文件已缓解） |
| 审计查询命令 | 未实现（当前 grep/jq 直读） |
| 中间目录整链 TOCTOU（宿主侧 FileService） | 已知残余，Node 无 `openat` 无法根治；SRT 只约束子进程 |
| macOS / Linux 隔离验证 | 未做（无环境） |

### 5.10 上游 Alpha 风险

SRT Windows 后端与 MXC SDK 均处早期阶段。**升级前必须重跑本报告 §4 全部脚本**；不得因"版本更新"默认放行。

## 6. 受控执行面（GUI 构建链的唯一出路）

| 项 | 实现 |
|---|---|
| 分类 | 规则仅从 `.pi/workflows/control-plane.json` 读取；模型无法声明 |
| 审批 | `request.approve`（受控工具注入，`ctx.ui.confirm`）→ 无 UI 即拒绝 |
| 审计 | `.pi/workflows/audit/control-plane-YYYY-MM-DD.jsonl`，append-only，只记事实 |
| 降级 | `RoutedCommandExecutor` 调用前路由，**沙盒失败不会转控制面** |

**实证**：同工程同一命令，沙盒外 49 文件 / 沙盒内 MXC 无法启动 / 受控面审批后 49 文件 —— 三路产物数量一致。
**审计实录**：

```
2026-11-27T01:43:48.609Z | denied   | exit=- | no_approval_channel
2026-11-27T01:44:27.584Z | approved | exit=0 | GUI 构建链无法在 MXC 内启动 | runId=run-audit
```

## 7. 威胁模型对齐（保护什么 / 不保护什么）

**受保护**：
- Agent 生成的命令无法写出工作区（MXC 写入边界）。
- 无法读取 `.ssh` / `.aws` / `.gnupg` / `.kube` / `.docker` 等凭据目录。
- 默认无网络；仅 Runtime 授予的域名可访问。
- 无法读取其他已登记工作区（含 junction / 大小写 / 嵌套绕过）。
- 取消/超时/父进程崩溃后不留孤儿进程。
- 无法自行解除隔离（Agent 传空 deny 被忽略）。

**不受保护**：
- GUI / Electron 应用的启动与运行（走控制面，等同用户本人执行）。
- 未登记为工作区的普通宿主目录。
- 宿主侧 `WorkspaceFileService` 的中间目录 TOCTOU 窗口。
- 桌面 UI 层（MXC 不隔离窗口、剪贴板以外的桌面交互语义需按上游文档核对）。
- 进程重启后丢失的历史工作区身份。

## 8. 复现与回归要求

```bash
# 1) 单元/契约（任何平台）
npm run build && npm run test:contract && npm run test:engine

# 2) Windows MXC 实证（需 Node ^24.21 || ^26.8）
NODE26="%LOCALAPPDATA%\nvm\v26.11.1\node.exe"
for s in m2-w0c-check m2-w2-check m2-w2b-wiring m2-w3-check m2-w4-check; do
  "$NODE26" --import ./node_modules/tsx/dist/loader.mjs dev-examples/mxc-probe/$s.ts
done
```

**任何一次 SRT / MXC SDK 版本变更、Windows 大版本升级后，必须重跑上述全部脚本并更新本报告。**

## 9. 签署

| 角色 | 结论 | 日期 |
|---|---|---|
| 实现方（AI 执行） | CONDITIONAL PASS，附 §5 全部限制 | 2026-11-25 |
| 评审方 | 待签署 | — |
| 产品决策 | 待签署 | — |

**放行条件**：评审方确认 §5 限制已随用户文档披露，且 §5.9 未验证项按需排期。

---

## 附录 A：相关文档索引

- 决策：`dev-docs/design/2026-11-25-D6-Windows-first-sandbox-strategy.md`
- 调研：`dev-docs/research/2026-11-24-pibot-sandbox-permission-research.md`
- 计划：`dev-docs/planning/2026-11-24-sandbox-permission-execution-plan.md`
- 阶段报告：`dev-docs/progress-result/M2.0-Windows平台验证报告.md`、`M2-W2-Workspace-Registry-MVP-执行报告.md`、`M2-W3-真实Cocos工程沙盒验证-执行报告.md`、`M2-W4-受控执行面-执行报告.md`
- 经验：`dev-docs/experience/pi-tool-call-handler-wrong-result-shape-silent-pass.md`、`filehandle-write-after-read-appends-at-position.md`
- 配置模板：`.pi/workflows/control-plane.example.json`

## 附录 B：实现清单

| 包 | 关键文件 |
|---|---|
| `packages/execution` | `sandbox/sandbox-config.ts`（配置基线/卷根/凭据 deny）、`sandbox/sandbox-host.ts`（一命令一进程/TEMP 隔离）、`sandbox/srt-executor.ts`（spawn/杀组/drain）、`sandbox/process-tree.ts`（Windows taskkill /T /F）、`workspace/{path-normalize,registry,ensure}.ts`、`command/{types,factory,control-plane,routed}.ts`、`audit/control-plane-audit.ts`、`files/{path-boundary,workspace-file-service}.ts` |
| `packages/policy-lite` | `permit.ts`（双阶段授权）、`evaluate.ts`、`command-analysis.ts`、`protected-paths.ts` |
| `packages/adapter` | `pi-agent-adapter.ts`（noTools:builtin + `extensionFactories` 受控注入）、`extensions/{policy-extension,agent-tools}.ts` |
| `apps/plugin` | `extensions/pi-code-mode.ts`（注册表单例 + 路由执行器 + 审计装配） |
