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
- v3（2026-11-25）：安全契约评审后新增 **M0.1 阶段**（已完成）：修正 probe 自身的 `as never` 矛盾、实证双阶段 Permit 防线（关键证据：handler 错误形态时 SDK 静默放行但 Permit 第二层拦性，`entered=1 executed=0`）、冻结 ToolPermit/PermitStore 契约。M4 旁路清单 +1（spawnSync Python 探测）；VM 安全边界表述精确化；新增工程原则"事件回调不得作为唯一防线"。

## 工程原则（v3 起强制）

**任何安全控制，都不能仅仅依赖 Agent Framework 的事件回调成功执行。真正执行外部副作用的最后一层，必须再次验证授权。**

落地形态即双阶段防线：tool_call 事件负责**授权**（Policy Gate -> 签发 Permit），Tool.execute 负责**强制执行授权**（验证 Permit 后才触碰 CommandExecutor / File Service）。两者不能互相替代：handler 返回错误形态、handler 抛异常、未来接入其他 Agent Runtime 或 MCP 工具时，第二层 Permit 校验都是完不成即拒绝的独立闸门。M0.1 已实证：SDK 对错误形态静默放行时（`entered=1`），无 Permit 的 execute 拒绝真实执行（`executed=0`）。

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

- [x] 创建 `dev-examples/sandbox-agent-probe/`（probe.ts，零模型段 + `--with-model <tier>` 模型段）。
- [x] `DefaultResourceLoader({ noExtensions: true, extensionFactories: [probeExt] })` + `createAgentSession({ noTools: "builtin" })`。
- [x] 验证：自定义工具注册成功；内置工具不可见；用户全局扩展未加载；tool_call 拦截 block 生效；abort 不抛异常。
- [x] 零模型验证优先：A1-A4 用 session 工具清单与 extensionsResult 断言，零 token；tool_call 端到端走 fast 档（2026-11-25 用户确认）。
- [ ] 冻结接口：`AgentToolRuntime`、`CommandExecutor`、`SandboxCommandRequest/Result`（M1 开工时定稿，PermitStore 契约已在 M0.1 冻结）。
- [ ] 修复执行身份：`AgentRunOptions` 增加 `runId`；workflow-runtime 传 `shared.runId`；agent-adapter.ts 去除 `runId: ""` 硬编码（M1 一并做，避免单独动 adapter）。

**M0 验证结论（2026-11-25，全部 PASS）**：

| 断言 | 结果 | 证据 |
|---|---|---|
| A1 probe 扩展 setup 运行 | PASS | `loaded=["probe-extension-setup"]` |
| A2 用户/项目扩展零加载 | PASS | 真实 `~/.pi/agent`（装有用户扩展）下 `extensions=["<inline:m0-probe>"]`，磁盘扩展零加载 |
| A3 内置工具全部禁用 | PASS | `active=["m0_probe_tool"]`，read/bash/edit/write/powershell/grep/find/ls 全部不可见 |
| A4 自定义工具在 active | PASS | 同上 |
| B1 tool_call 拦截 block 生效 | PASS | fast 档（deepseek-v4.1-flash）真实模型调用，handler block 后 toolResult `isError=true`（模型重试再次被拦） |
| B2 abort 不抛异常 | PASS | abort 路径执行；严格信号传播断言留 M1 CommandExecutor |

**踩坑沉淀（安全级）**：tool_call handler 返回 `{ action: "block" }`（错形态）时 pi 静默放行工具，不报错——详见 `dev-docs/experience/pi-tool-call-handler-wrong-result-shape-silent-pass.md`。正确形态是 `ToolCallEventResult { block?: boolean, reason?: string }`（SDK `emitToolCall()` 只检查 `result.block` 字段）。防御已由 M0.1 的双阶段防线实证（见下）。

### M0.1：安全契约修正（2026-11-25 完成）

M1 的正式前置条件。任务与结论：

- [x] 删除 probe 中全部危险类型强转（唯一保留的 `as never` 是故意的敌手模拟，有注释；tsc --strict 零错误）。
- [x] 验证 ToolCallEventResult 类型契约（正确形态 `{ block, reason }`，无强转自然过类型）。
- [x] 增加工具实际执行计数（`entered`/`executed` 双计数：SDK 层放行 vs 真实副作用层）。
- [x] 验证错误返回形态不会导致命令执行（C2：`entered=1 executed=0`）。
- [x] 冻结 PermitStore 契约（见下）。

**M0.1 验收结果（probe 10/10 PASS，fast 档沿用 2026-11-25 用户确认）：**

| 测试 | 预期 | 实测 | 状态 |
|---|---|---|---|
| 正确 block 返回 | isError=true | blocked=1，probeResult isError=true | PASS |
| block 后工具执行计数 | 0 | entered=0 executed=0 | PASS |
| 错误返回形态 | 不产生 Permit | handler 无签发动华 | PASS |
| 错误返回形态下调用工具 | Tool.execute 拒绝 | **entered=1 executed=0**（SDK 静默放行但第二层拦住） | PASS |
| 无 Permit 直接执行 | 拒绝 | execute 统一 permit 检查入口 | PASS |
| Permit 一次性消费 | 第二次拒绝 | first=true second=false | PASS |
| Permit 过期 | 拒绝 | consumed=false | PASS |
| allow 路径正常 | 执行 1 次 | executed=1 | PASS |
| A1-A4 回归（扩展隔离/内置禁用/自定义注册） | 全部保持 | 全 PASS | PASS |
| strict 类型检查 | 零错误 | tsc --noEmit --strict exit=0 | PASS |

（并发不串扰与参数摘要不匹配两项在 M1 的 PermitStore 正式实现 + contract 测试中补齐，probe 单会话场景无法构造并发竞争。）

**冻结契约：ToolPermit / PermitStore（M1 落地为 `packages/policy-lite/src/permit.ts`）**

```ts
interface ToolPermit {
  toolCallId: string   // SDK 契约：tool_call 事件与 execute 首参同 ID
  toolName: string
  paramsDigest: string // SHA-256(稳定序列化参数)，防 input 途中被改（SDK 明确：handler 改 input 后不重新 schema 校验）
  issuedAt: number
  expiresAt: number    // 缺省 60s TTL
}
```

规则：
1. 按 toolCallId 查找 -> 校验工具名 -> 校验参数摘要 -> 校验过期 -> 一次性删除 -> 全过才放行；任一失败 fail-closed。
2. PermitStore 按 AgentSession 隔离，禁止全局共享 Map。
3. Policy Extension 不主动修改 `event.input`；Tool.execute 对参数做二次 schema 校验；摘要必须与 execute 实收参数一致。
4. Policy 异常（抛错）时 fail-closed：不签发 Permit，execute 拒绝。

### M1：Agent 自定义工具层（1.5～2 天）—— 2026-11-25 完成

- [x] 实现 `agent-tools` Extension：注册 `run_command` / `read_file` / `write_file` / `edit_file`。
- [x] 实现 `policy-extension`：tool_call -> Policy Gate -> 按 M0.1 冻结契约签发一次性 Permit。
- [x] 实现 `packages/policy-lite/src/permit.ts`：PermitStore（session 隔离、一次性消费、参数摘要、TTL）。
- [x] 文件操作全走 Workspace File Service（canonicalize/realpath 校验 + symlink 逃逸防护）。
- [x] 未知工具默认拒绝。
- [x] PiAgentAdapter 改造：loader 注入受控 factories；`noTools: "builtin"`；旧工具名映射（read->read_file 等）；PermitStore 每调用独立并在 finally 清理。
- [x] CommandExecutor 用 fail-closed 默认实现（UnavailableCommandExecutor），零宿主机旁路。
- [x] runId 贯通：AgentRunOptions.runId -> shared.runId -> ctx.runId -> CommandExecutor 审计字段。

验收结果：contract sandbox-m1 18/18（含 M0.1 C2 正式化：错误形态 SDK 放行但第二层拦截、executor 零调用；参数篡改 digest 拒绝；双 store 并发独立）；全量 contract 268/0、engine 222/0、optimizer 65/0；adapter 级 e2e 4/4（fast 档：write_file 落盘 / readBack+结构化输出 / run_command blocked / bash 不可用）。详见 dev-docs/progress-result/M1-受控工具层-执行报告.md。

### M1.1：安全收尾（M2 前置，2026-11-25 完成）

评审发现的 5 个问题全部修复（P0×2 / P1×2 / P2×1 + 2 个小项）：

- [x] **P0 noExtensions 固定 true**：ToolPolicy 删除 noExtensions 字段（不可配置）。理由：扩展运行在 Agent 宿主进程不受 Sandbox 约束，加载不可信磁盘扩展 = 绕过 Policy Gate / Permit / CommandExecutor 全部防线。未来开放第三方扩展走宿主层可信白名单，不是开放 noExtensions。
- [x] **P0 extraTools 删除**：受控 4 工具之外一律 deny（evaluate.ts）。未来新增工具必须同时接入 Tool Gateway 的 Permit 消费，不允许先放行再补防线。新增测试：任意未知工具名（web_fetch/mcp_call/custom_tool 等）deny。
- [x] **P1 TOCTOU 加固**：openWithin（canonicalize 边界 + lstat 拒绝 symlink 最终组件 + create 用 wx（O_CREAT|O_EXCL 不跟随最终 symlink）+ 打开后 fstat 与 lstat dev/ino 复核）；全部 IO 从 FileHandle（fd）走，打开后不再路径解析。攻击测试 2 个（Windows 无特权 file-symlink EPERM 时显式 skip，Linux/CI 跑全量）。**残余风险已注释声明**：中间目录整链在检查后替换的窗口仍在（Node 无 openat），由 M2 沙盒策略收窄 + FileService 拒绝 symlink 最终组件缓解，OS 级完整隔离依赖 M2 SRT。
- [x] **P1 AbortSignal 贯通**：agent-tools execute 接收 SDK 第三参 signal（Engine abort -> session.abort -> 工具 signal）→ FileService 读 / CommandExecutor 请求；e2e E3b 实证 signals=passed。M2 起一路到 Sandbox Host 进程组。
- [x] **P2 e2e 确定性加强**：E0 零模型直查 SDK 工具清单（恰好受控 4 工具、零 builtin 泄漏）；E3 注入 CountingExecutor 断言调用次数=1（SDK 真实执行了工具的证据，不依赖模型自述）+ blocked + signal。模型自述 / SDK 执行 / 副作用层三层证据分离。
- [x] **小项 Permit 强化**：完整 SHA-256（无截断）；consume 找到凭证后无论校验结果如何一律销毁（失败尝试不得保留重试机会），测试覆盖。

**过程中抓到并修复 1 个真 bug**：fd 化后 edit 的读后写从 fd 尾部追加（FileHandle position 语义），详见 `dev-docs/experience/filehandle-write-after-read-appends-at-position.md`。

验收：sandbox-m1 22/22；全量 contract 272/0、engine 222/0；build 零错误；e2e 5/5（E0 零模型工具清单 + E1 落盘 + E2 读回/结构化 + E3 确定性 + E3b signal）。

### M2：Sandbox Execution 实现（2～3 天）—— 第一批完成（2026-11-25，Mac 实测待跑）

**第一批交付（M2.0/M2.1 基础实现）**：`sandbox-config.ts`（工作区可写/凭据禁读/网络 strictAllowlist 全拒/环境变量黑名单/绝对路径规范化）、`sandbox-host.ts`（一命令一 Host、stdin 单行 JSON、fd3 控制通道 ready/failed/violations/exit、进程组回收）、`srt-executor.ts`（abort/timeout 杀组 + drain + Windows 拒绝）、`command/factory.ts`（平台工厂）、插件装配 `createCommandExecutor()`。SRT 精确固定 `0.0.81`。
本机（Windows）已验证：build 零错误、sandbox-m2 9/9、contract 285/0、engine 222/0、e2e 5/5、Host 协议自检（`failed 125` + 命令零执行）。**M2.0 五项验收脚本 `dev-examples/sandbox-agent-probe/m2-check.ts` 待 Mac mini 执行**。详见 `dev-docs/progress-result/M2.0-沙盒执行层第一批-执行报告.md`。


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

消除全部 5 处既有旁路（2026-11-25 v3 核实清单）：

| 旁路 | 位置 | 处理 |
|---|---|---|
| verifier 命令执行 | `packages/engine/src/optimizer/verifier-runner.ts` L122（execFile） | 改注入 CommandExecutor，在 after 工作区执行；保留超时/exitCode/stdout/stderr 契约 |
| workflow check helper | `packages/engine/src/runtime/workflow-runtime.ts` L1374 `commandSuccess`（exec，任意 shell） | 改走 CommandExecutor（或沙盒内等价物）；check 语义不变 |
| workflow runTool | `workflow-runtime.ts` `TOOL_INTERPRETER`/execFile（按脚本路径执行） | 脚本路径过工作区边界校验后走 CommandExecutor |
| Python 解释器探测 | `workflow-runtime.ts` `spawnSync(bin, ["-V"])`（runTool 前置探测） | 登记为受控启动探测：仅 `-V` 探测无参数注入面，纳入执行入口审计清单，保留但禁止扩大用途 |
| git 控制面 | `packages/engine/src/isolation/worktree.ts` L46（execFile git） | 保留为受控 Control Plane（内部工作区管理，非模型可达），文档明示边界 |

**VM 安全边界（v3 精确化，禁止笼统宣称 Workflow JS 受 OS Sandbox 保护）：**

- Agent 命令：必须走 Sandbox。
- Workflow Runtime 启动的外部命令和脚本：必须走 CommandExecutor。
- Workflow VM：仍是可信代码执行环境（vm.ts 自述"不是安全沙箱"），不属于本次 OS 隔离范围。
- Worktree Git：受控 Control Plane，保留明确的内部执行权限。
- Python 解释器探测：纳入执行入口审计，明确处理方式。

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
| 2026-11-25 | M0 探针验证 | done | probe 6/6 PASS（零模型 A1-A4 + fast 档 B1/B2）；沉淀 tool_call 返回形态安全坑；接口冻结与 runId 贯通移入 M1 |
| 2026-11-25 | v3 + M0.1 安全契约 | done | 评审意见落地：probe 删 as never（tsc strict 零错误）；双阶段 Permit 防线实证（C2：错误形态 SDK 静默放行但第二层拦住，entered=1 executed=0）；PermitStore 契约冻结；旁路清单 5 处；VM 边界精确化；新增工程原则。probe 10/10 PASS |
| 2026-11-25 | M1 受控工具层 | **done** | policy-lite + execution 两个 L1 包落地；policy-extension/agent-tools 双阶段防线；PiAgentAdapter noTools+受控注入+旧名映射；runId 贯通；contract 268/0 + engine 222/0 + optimizer 65/0 + e2e 4/4（fast）。报告：progress-result/M1-受控工具层-执行报告.md |

## 9. 参考引用

- PiBot：REF-023，commit 86a7967；源码 thirdparties/PiBot（packages/policy、packages/execution/src/sandbox、packages/brain/src/core/approvals.ts）
- Pi SDK 1.3.0 源码（本机 node_modules/@earendil-works/pi-coding-agent/dist）：core/sdk.d.ts（noTools）、core/resource-loader.js（loadCurrentExtensionSet/loadExtensionFactories）
- Pi SDK 上游：https://github.com/earendil-works/pi（v1.3.0 packages/coding-agent/src/core/resource-loader.ts、sdk.ts）
- Anthropic Sandbox Runtime：https://github.com/anthropics/sandbox-runtime
- 调研报告：dev-docs/research/2026-11-24-pibot-sandbox-permission-research.md
- 本仓库规范：CLAUDE.md（命令开发规范、model-tiers 强制、自测纪律、联调约定）
