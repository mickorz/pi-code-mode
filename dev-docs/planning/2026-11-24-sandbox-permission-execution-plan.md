# PiAgentAdapter 受控工具注入与 Sandbox Execution 改造计划

> 状态：待执行（M0 未启动）
> 日期：2026-11-24 初版 / 2026-11-25 修订（v2，定位重构）
> 目标仓库：pi-code-mode
> 参考项目：PiBot（REF-023，commit 86a7967）
> 技术基础：Pi SDK 1.3.0（已核实）+ Anthropic Sandbox Runtime
> 调研依据：`dev-docs/research/2026-11-24-pibot-sandbox-permission-research.md`

## 修订记录

- v1（2026-11-24）：初版定位"Sandbox 适配器 + tool_call 事件拦截"。
- v2（2026-11-25）：定位改为 **Agent 工具执行层重构**。拦截方式从 tool_call 事件被动拦截，改为 **受控扩展注入 + 自定义工具 + 双阶段 permit**。触发原因：核实 Pi SDK 1.3.0 已有公开 API（`extensionFactories` + `noTools: "builtin"`），无需复制 PiBot 的私有 Extension Loader，且执行权下沉（禁用内置 bash、命令走统一 Sandbox）比事件拦截更彻底。v1 的 M0/M4 大部分内容被本版吸收重排。

## 1. 定位与核心目标

这不是"给 pi-code-mode 加一个 Sandbox 适配器"，而是 **Agent 工具执行层重构**：

**保留现有 Workflow Engine、Worker、SQLite Durable Execution 和 Dashboard，只调整 Pi Agent 的工具注册与执行链路，让 Agent 和 Workflow 都通过统一的 Sandbox Execution 层执行命令。**

三个原则（PiBot 参照）：

1. **受控扩展注入**：只加载 pi-code-mode 自己需要的 Extension，不开放用户环境的全部扩展。
2. **执行权下沉**：Agent 不再直接使用 Pi 内置 bash 执行宿主机命令。
3. **统一执行边界**：Agent 工具和 Workflow JS 后续使用同一套 Sandbox 执行接口，避免两套安全体系。

类比：v1 方案是"在现有安检口加一道闸门"（tool_call 事件拦截，命令仍走 pi bash，只是拦一道）；v2 是"关闭旧安检口，新开唯一安检大厅"（内置工具禁用，所有动作从我们自己注册的工具走，闸门内建在工具执行链上）。前者拦不完（漏一个工具就裸奔），后者天然完备（没有别的路）。

## 2. 关键技术判断（2026-11-25 核实）

以下判断已对照本机 `node_modules/@earendil-works/pi-coding-agent@1.3.0` 的 dist 源码逐条核实：

| 判断 | 结论 | 证据 |
|---|---|---|
| SDK 版本 1.3.0 | 属实 | 根 package.json `1.3.0` |
| `DefaultResourceLoader.extensionFactories: InlineExtension[]` 存在 | 属实 | dist/core/resource-loader.d.ts L79 |
| `createAgentSession.noTools: "all" \| "builtin"` 存在 | 属实 | dist/core/sdk.d.ts L33，注释明确 "disable the default built-in tools (read, bash, edit, write) but keep extension/custom tools enabled" |
| `noExtensions=true` 与 `extensionFactories` 可同时用 | 属实 | resource-loader.js `loadCurrentExtensionSet()`：noExtensions 只过滤磁盘发现的 extensionPaths，`includeInlineFactories: true` 分支无条件调 `loadExtensionFactories()` 追加 inline 工厂 |
| verifier-runner.ts 用 child_process.execFile | 属实 | packages/engine/src/optimizer/verifier-runner.ts L122 |
| worktree.ts 用 child_process.execFile（git 控制面） | 属实 | packages/engine/src/isolation/worktree.ts L46 |
| agent-adapter.ts 硬编码 runId | 属实 | packages/adapter/src/agent-adapter.ts L67 `runId: ""`，注释"AgentRunOptions 无 runId 字段（runtime 零修改原则）"——本改造有意打破该原则，执行身份必须贯通 |
| ~~workflow-runtime.ts 无通用 shell 能力~~ | **不属实（v2 修正）** | workflow-runtime.ts L30 `import { exec, execFile, spawnSync }`：① L1374 `commandSuccess` helper 用 `exec` 跑**任意 shell 命令**（VM check 注入面）；② `runTool`（P4.1-B 原生工具节点）用 `execFile` 按 workflow 脚本指定的路径跑脚本。**旁路清单共 4 处，M4 全部纳入** |

现状有利条件：`pi-agent-adapter.ts` 已使用 `DefaultResourceLoader({ noExtensions })` + `createAgentSession`（L65/L80），改造即在此处增加 `extensionFactories` 与 `noTools: "builtin"` 两个参数，接入成本极低。

最终接入决策：

| 参数 | 值 | 语义 |
|---|---|---|
| `noExtensions` | `true`（保留现状） | 不加载宿主/项目磁盘发现的扩展 |
| `extensionFactories` | 新增 | 注入 pi-code-mode 自己的 policy + agent-tools 扩展 |
| `noTools` | `"builtin"` | 禁用 pi 默认 read/bash/edit/write，保留自定义工具 |

不使用 PiBot 的私有 `loadExtensionFactories()` 桥接，用 SDK 1.3.0 公开 API。

## 3. 目标架构

```
Workflow Engine（不动）
  agent() / parallel() / pipeline()
    |
AgentAdapter Contract（接口不动：executionId / runId / AbortSignal）
    |
PiAgentAdapter（改造点）
  noExtensions=true · noTools="builtin" · extensionFactories=[policy, agent-tools]
    |
受控 Extension Runtime
  Policy Extension（tool_call 事件 -> Policy Gate -> 一次性 permit）
  Agent Tools Extension（run_command / read_file / write_file / edit_file）
    |
统一 Tool Gateway（permit 校验：toolCallId + 工具名 + 参数摘要）
    |                              |
Workspace File Service        CommandExecutor（Sandbox Execution）
  canonicalize/realpath         sandbox-config · sandbox-host（一命令一进程）
  路径边界校验                    @anthropic-ai/sandbox-runtime
                               macOS Seatbelt / Linux bubblewrap+seccomp
```

职责边界：

- **文件工具**（read/write/edit）由受控 Workspace File Service 执行，必须过路径权限校验（canonicalize/realpath 防符号链接逃逸）。
- **命令工具**（run_command）由 Sandbox Execution 执行，不允许直接宿主 exec。
- **Workflow JS** 继续用原 VM/Runtime，不在本次改造范围（VM 定位是确定性，非安全）。
- **MCP** 保留 Workflow Runtime 直调通道，不重新装配进子 Agent。
- **双阶段授权**（PiBot 同款）：tool_call 事件触发 Policy Gate → 通过后生成一次性 permit → 工具 execute 按 toolCallId+工具名+参数校验 permit → 通过才执行。禁止无 permit 绕过。

## 4. 里程碑

### M0：Pi SDK 接入验证与接口冻结（0.5～1 天）

目标：证明不修改 Pi SDK 即可实现受控工具注入。

- [ ] 创建 `dev-examples/sandbox-agent-probe/`，<100 行测试扩展。
- [ ] `DefaultResourceLoader({ noExtensions: true, extensionFactories: [probeExt] })` + `createAgentSession({ noTools: "builtin" })`。
- [ ] 验证：自定义工具注册成功；内置 read/bash/edit/write 不可见；用户全局扩展未加载（probe 扩展 setup 日志为唯一来源）；tool_call 事件可拦截（block 生效）；取消信号传递到工具执行过程。
- [ ] 零模型验证优先：工具注册/禁用/扩展加载均通过 session 工具清单与扩展 setup 日志断言，不烧 token；tool_call 端到端拦截若需走模型，按 model-tiers 规范先确认档位（建议 fast）。
- [ ] 冻结接口：`AgentToolRuntime`、`CommandExecutor`、`SandboxCommandRequest/Result`。
- [ ] 修复执行身份：`AgentRunOptions` 增加 `runId`；workflow-runtime 传 `shared.runId`；agent-adapter.ts 去除 `runId: ""` 硬编码；保留 executionId 体系。

验收：自定义工具在 noExtensions=true 下可执行；用户扩展零加载；内置工具不可用；tool_call 拦截生效；Workflow Engine 调度语义不变。

### M1：Agent 自定义工具层（1.5～2 天）

- [ ] 实现 `agent-tools` Extension：注册 `run_command` / `read_file` / `write_file` / `edit_file`。
- [ ] 实现 `policy-extension`：tool_call → Policy Gate → 一次性 permit。
- [ ] 文件操作全走 Workspace File Service（canonicalize/realpath 校验）。
- [ ] 未知工具默认拒绝。
- [ ] PiAgentAdapter 改造：loader 注入受控 factories；`noTools: "builtin"`；兼容现有 allowTools/excludeTools 映射到新工具名；工具执行 signal 与 request.signal 合并。
- [ ] CommandExecutor 用测试 Mock，**生产链路不增加宿主机直接执行旁路**。

验收：Agent 能读写工作区文件、发起 run_command；全部工具过统一权限检查；不再暴露 pi bash；AgentAdapter 的结构化输出/usage/partial/cancel 契约不回归。

### M2：Sandbox Execution 实现（2～3 天）

- [ ] 引入并固定 `@anthropic-ai/sandbox-runtime` 版本（PiBot 用 0.0.81，按当前可用版固定）。
- [ ] `packages/execution/src/sandbox/`：sandbox-config / sandbox-host（独立宿主进程）/ sandbox-manager / violations。
- [ ] 父子生命周期：stdin 单行 JSON payload 保活；独立控制通道回报 ready/failed/violations；stdout/stderr 流式回传；超时与 AbortSignal；进程组清理与 drain 确认；每命令独立临时目录。
- [ ] 沙盒边界配置：工作区可写；系统目录只读；凭据目录（.ssh/.gnupg/.aws 等）禁读；工作区外写默认禁止；网络默认严格拒绝（strictAllowlist）；环境变量黑名单（JAVA_TOOL_OPTIONS、GIT_CONFIG_COUNT）；Git 元数据写入单独保护。
- [ ] **SRT 是模块级单例（PiBot 实测：manager 按最近一次全局配置过滤），强制一命令一 Sandbox Host 进程，多命令配置不得串扰。**
- [ ] Windows/不支持平台返回 `isolation_unavailable`，禁止降级宿主执行。

验收：工作区内命令正常；工作区外写被拦；敏感路径被拦；网络按白名单；并行命令配置互不影响；取消无孤儿进程；不支持平台明确拒绝。

### M3：Policy Lite 与安全边界（1.5～2 天）

- [ ] `packages/policy-lite/`：types / evaluate / levels / protected-paths / command-analysis。
- [ ] 类别：`run_command`（风险分析+沙盒）、`read_file` / `write_file` / `edit_file`（工作区路径校验）。
- [ ] 三态裁决：allow / ask / deny；ask 在 headless（无审批 UI）**fail-closed 拒绝**，不自动放行。
- [ ] 保守命令分析（不引 tree-sitter）：危险命令、重定向、网络访问、incomplete 一律 ask。
- [ ] 持久 Grant / 撤销 / 根会话审批 UI 留后续迭代，不阻塞 MVP。

验收：危险命令不因普通 allow 放行；越界操作不能绕过路径检查；未知操作不默认允许；headless 不绕过人工审批。

### M4：统一执行入口、生命周期与可观测性（1～2 天）

消除全部 4 处既有旁路（2026-11-25 核实清单）：

| 旁路 | 位置 | 处理 |
|---|---|---|
| verifier 命令执行 | `packages/engine/src/optimizer/verifier-runner.ts` L122（execFile） | 改注入 CommandExecutor，在 after 工作区执行；保留超时/exitCode/stdout/stderr 契约 |
| workflow check helper | `packages/engine/src/runtime/workflow-runtime.ts` L1374 `commandSuccess`（exec，任意 shell） | 改走 CommandExecutor（或沙盒内等价物）；check 语义不变 |
| workflow runTool | `workflow-runtime.ts` `TOOL_INTERPRETER`/execFile（按脚本路径执行） | 脚本路径过工作区边界校验后走 CommandExecutor |
| git 控制面 | `packages/engine/src/isolation/worktree.ts` L46（execFile git） | 保留为受控 Control Plane（内部工作区管理，非模型可达），文档明示边界 |

- [ ] Agent 生命周期：session.dispose → Sandbox Host release → AbortSignal 传播 → runId/executionId 关联 → 清理完成后才结束执行。
- [ ] 观测事件：tool.started / tool.updated / tool.finished / sandbox.blocked，只记事实（工具名、类别、路径、域名、原因码、时长），不记密钥/完整提示词/敏感内容。
- [ ] Workflow Journal / SQLite / Dashboard 结构性零回归。

## 5. 首期明确不做

1. 不重构 Workflow VM（其定位是确定性，非安全）。
2. 不修改 Durable Worker + SQLite 架构。
3. 不修改 Dashboard。
4. 不把 MCP 重新装配到子 Agent。
5. 不实现 PiBot 150 类审计事件（取 4 类子集）。
6. 不实现完整 tree-sitter-bash 分析（保守文本分析起步）。
7. 不实现跨项目/跨用户 Grant 管理（持久 Grant 后续迭代）。
8. 不引入 computer-use、浏览器操作。
9. 不为 Windows 兼容回退宿主机执行（不支持即拒绝；WSL2/Docker 后端另议）。

## 6. 总体验收标准

| 项目 | 通过标准 |
|---|---|
| Extension 隔离 | 只加载受控 ExtensionFactory，用户扩展零加载 |
| Builtin 工具 | 子 Agent 不再使用 pi 内置工具 |
| Tool Policy | 无 permit 的工具调用无法执行 |
| 文件边界 | 越出工作区的读写被拒（含符号链接逃逸防护） |
| 命令边界 | Agent 命令必须走 Sandbox |
| OS 隔离 | 不支持隔离的平台拒绝执行（不降级） |
| 进程管理 | 取消/超时后无孤儿进程 |
| 并行隔离 | 多命令沙盒配置不串扰 |
| 旁路清理 | verifier / check helper / runTool 全部走 CommandExecutor |
| 身份追踪 | runId / executionId 全链路贯通 |
| 原有能力 | Workflow、结构化输出、重试、恢复、Dashboard 不回归 |

## 7. 执行纪律

- 严格 M0 → M1 → M2 → M3 → M4；M0 未过不开工 M1，M1 未证明自定义工具链路不碰 SRT，M2 未过进程隔离测试不接生产 Agent。
- 每里程碑收尾：`npm run build`（类型关卡）→ `npm run test:contract` → 专项测试 → 端到端 `pi -ne -e <repo> -p` 自测（Git Bash 加 `MSYS_NO_PATHCONV=1`；看产物与状态，不看 print 模式 UI）。
- 并发联调遵守仓库专项约定（最多 2 个长时用例、看门狗、journal 落盘证据优先）。
- 本方案零大模型调用；若引入 AI 辅助风险分析，先问 model-tiers 档位（分析类建议 big，执行类建议 fast）。
- 每里程碑完成同步更新 `dev-docs/progress/执行进度.md` 与 `dev-docs/progress-result/` 独立阶段报告。
- 平台验证顺序（用户既定）：Mac mini 首验 SRT，Linux 补测试，Windows 显式 unsupported。

## 8. 执行记录（滚动更新）

| 日期 | 里程碑 | 状态 | 备注 |
|---|---|---|---|
| 2026-11-24 | v1 文档创建 | done | 定位 Sandbox 适配器 + tool_call 拦截 |
| 2026-11-25 | v2 修订 | done | 重构定位；SDK 1.3.0 六项判断核实（一项修正：workflow-runtime 有 exec/execFile 旁路）；旁路清单定为 4 处 |
| （待填） | M0 | pending | |

## 9. 参考引用

- PiBot：REF-023，commit 86a7967；源码 thirdparties/PiBot（packages/policy、packages/execution/src/sandbox、packages/brain/src/core/approvals.ts）
- Pi SDK 1.3.0 源码（本机 node_modules/@earendil-works/pi-coding-agent/dist）：core/sdk.d.ts（noTools）、core/resource-loader.js（loadCurrentExtensionSet/loadExtensionFactories）
- Pi SDK 上游：https://github.com/earendil-works/pi（v1.3.0 packages/coding-agent/src/core/resource-loader.ts、sdk.ts）
- Anthropic Sandbox Runtime：https://github.com/anthropics/sandbox-runtime
- 调研报告：dev-docs/research/2026-11-24-pibot-sandbox-permission-research.md
- 本仓库规范：CLAUDE.md（命令开发规范、model-tiers 强制、自测纪律、联调约定）
