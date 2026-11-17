# pi-code-mode：MCP Tool Integration 执行计划

- 日期：2026-11-17
- 状态：**M0 实证 + M1 + M2 + M4 直调已全部完成**（M3 与 M4 剩余项另行立项）
- 范围：M0 + M1 + M2 + M4 直调（Agent 调用 MCP + Workflow JS 直调 MCP）；M3/M4 剩余项列为后续方向
- 上游方案：ChatGPT 调研稿（2026-11-17），经本仓库独立验证后修订
- 修订记录：2026-11-17 v2 —— 按评审意见补充 5 个技术问题落点：M0-2/M0-5 加工具级与 hidden 实证（P0）、
  M0-4 扩为 6 组对照实验、新增 M0-6（Journal 可观测范围，静态结论已先行完成）、M2 加两层权限优先级规则与
  `toolCalls[]` 审计交付、风险表加信任边界与凭证保护；修正第五节关于 journal 的错误表述
- 修订记录：2026-11-17 v3 —— 按评审意见补 4 项（均已源码验证）：P0-1 DSL 透传链补齐三处断点、
  P0-2 默认 hidden 生成规则（官方 toolExposure 通配符语义直接支撑，新增 F12）、
  P1-1 toolCalls 脱敏收紧（redactValue 定位为展示用途非安全边界）、
  P1-2 toolCalls 完整数据通道（成功/失败 attempt 双落点）
- 修订记录：2026-11-17 v4（终版，冻结）—— 收尾小修订：P0 失败 attempt 事件传递机制锁定
  （throwForStatus 断点实证，采方案 A 事件侧实时上报，经 ctx.onEvent record 变体与 executionId 防重试混淆）、
  P1 通配符两层交叉测试矩阵、P2 F1-F12 状态表与 DSL 表述修正。**本文档冻结，进入 M0 运行时实证。**
- 修订记录：2026-11-18 M4 直调完成 —— 按用户明确预期交付「workflow JS 内直接调 MCP」（官方 code-mode 同款形态）：
  受控 client 池（pi-mcp McpClient + 懒连接 + 请求级 60s 超时 + dispose 显式回收）、globals 注入
  mcp.call/listTools/listServers 与官方 prelude 同款 tools 预生成函数对象（node:vm 跨边界 Proxy 不可靠，
  改预生成）、meta.mcp 脚本级声明（默认拒绝 + child 收敛 root 白名单）、onMcpCall 审计 + toolCount 计入。
  契约 10 断言 + 宿主真实 server e2e 6 断言全 PASS，详见 `dev-docs/progress-result/MCP-M4-执行报告.md`。
- 修订记录：2026-11-18 M2 完成 —— M1 策略层（filterMcpConfig 三铁律）与 M2 AgentAdapter 接入
  （P0-1 透传链三断点补齐、executionId 贯通、事件侧 toolCalls 采集与成功/失败双落点）全部交付，
  端到端联调通过，详见 `dev-docs/progress-result/MCP-M2-执行报告.md`。**本期（M0/M1/M2）全部完成。**
- 修订记录：2026-11-18 M0 完成 —— 运行时实证 M0-1 ~ M0-6 全部通过（57 断言 0 失败），详见
  `dev-docs/progress-result/MCP-M0-执行报告.md`；新增实证事实 F13-F18（注册层 codemode→deferred 映射、
  server 名 - 到 _ 替换、dispose 不回收 stdio 子进程、401 server 阻塞好 server、事件流工具载荷、
  parentToolCallId 嵌套归因），对 M1/M2 的五条直接影响见执行报告第三节

---

## 〇、对原方案的三个修正（实证后）

原方案方向成立，但有三处与 SDK 1.3.0 实际情况有出入，已按实证结果修订：

### 修正 1：不需要自建完整 MCP Manager（M1 范围大幅收缩）

原方案建议新建 `src/mcp/`（manager / server-registry / tool-registry / access-policy / config-loader 五个模块）。
实证发现 **pi 内建 MCP 扩展已经提供其中约 90% 的能力**，自建等于复造：

| 原方案自建模块 | SDK 已内建能力 | 证据 |
|---|---|---|
| mcp-config-loader | `loadMcpConfig({agentDir, cwd, projectTrusted})`，读 `~/.pi/agent/mcp.json` + 受信项目 `.pi/mcp.json`，`mcpServers` 格式兼容主流客户端 | `extensions/mcp/config.d.ts` |
| mcp-server-registry | 连接生命周期、OAuth（`mcp-auth.json`）、日志（`mcp.log`）、重连、启动等待（`startupWaitMs`） | `extensions/mcp/index.d.ts` |
| mcp-tool-registry | 工具发现 + 命名 `mcp__<server>__<tool>` + exposure 分级（`codemode`默认/`direct`/`deferred`/`hidden`）+ 逐工具覆盖 `toolExposure` | 同上 |
| mcp-manager | `pi.registerMcpServer(name, config)` 程序化注册；`/mcp` 管理面板 | `core/extensions/types.d.ts:1388` |

**M1 修订为薄策略层**：只需一个 `mcp-policy` 模块（预计单文件），职责是
「读默认配置 → 按 Agent 的 MCP 权限过滤 → 产出过滤后的 `LoadedMcpConfig`」，
经 `McpExtensionOptions.loadConfig` 钩子注入每个子会话。详见第三节。

### 修正 2：「Codemode 权限穿透」问题官方已解决，不需要额外设计

pi-mcp 扩展文档原文：
> Every call runs through pi's tool pipeline, so `tool_call`/`tool_result` hooks and
> permission extensions apply to MCP tools the same way they do to built-in tools.

即 codemode 脚本内的 MCP 调用与内建工具走同一条工具管线，`beforeToolCall` 权限钩子天然生效。
我们不需要自建穿透防护，只需要在 M0 用一个实证用例确认该行为（见 M0-3）。

### 修正 3：`ToolPolicy.mcp.exposure` 字段不需要

原方案建议在 ToolPolicy 里加 `exposure: "direct" | "codemode" | "deferred"`。
实证发现 exposure 是 **per-server/per-tool 配置字段**（`McpServerConfig.exposure`、`toolExposure`），
由 pi 扩展直接消费。Agent 策略层只需传递 per-server 的 exposure 覆盖值，不必另造一层语义。

---

## 一、已完成的实证基线（本文档撰写时同步验证，M0 前半部已完成）

以下事实全部在本仓库 node_modules（`@earendil-works/pi-coding-agent@1.3.0`）中逐条核实：

| # | 事实 | 证据位置 |
|---|---|---|
| F1 | 现有 `ToolPolicy` 仅 `excludeTools` / `noExtensions` / `allowTools` 三字段 | `src/adapter/types.ts:9-14` |
| F2 | `noExtensions` 默认 true（`policy.noExtensions !== false`），递归防护成立 | `src/adapter/pi-agent-adapter.ts:58-60` |
| F3 | SDK 1.3.0 导出 `createMcpExtension` / `createCodemodeExtension` / `createToolSearchExtension` | `dist/index.d.ts:30-34` |
| F4 | `DefaultResourceLoader` 支持 `extensionFactories?: InlineExtension[]`；实现上 `noExtensions: true` 只过滤磁盘扩展路径，inline 工厂走独立加载路径 `loadExtensionFactories()` **不受 noExtensions 影响** | `dist/core/resource-loader.js:409, 878` |
| F5 | 官方 SDK 文档明确：CLI 把三者作为内建扩展加载，SDK 会话不会自动加载，需显式加入 `extensionFactories`；`codemode`/`tool_search` 注册后默认 inactive；MCP 扩展按 exposure 自动激活对应工具；**必须调用 `session.bindExtensions({})` 触发 `session_start` 才会连接 MCP Server** | pi 官方 `docs/sdk.md:116` |
| F6 | 官方可运行示例存在，可直接作为 M0 实证脚本模板 | `examples/sdk/14-codemode-mcp.ts` |
| F7 | `McpExtensionOptions.loadConfig?: (ctx) => LoadedMcpConfig` 可注入自定义配置加载 —— 按 Agent 过滤 Server 的官方入口 | `extensions/mcp/index.d.ts` |
| F8 | `LoadedMcpConfig = { servers: McpServerEntry[], autoEnableCodemode?, errors, projectConfig? }`；`McpServerEntry = { name, config, source, scope?, override? }` | `extensions/mcp/config.d.ts` |
| F9 | MCP 工具调用走统一工具管线，权限钩子对 MCP 工具同样生效 | `extensions/mcp/index.d.ts` 头注释 |
| F10 | pi-mcp@1.3.0 独立导出 `McpClient` / `StdioTransport` / `StreamableHttpTransport` / OAuth —— M4 的 workflow 直调通道无需起会话 | `pi-mcp/dist/index.d.ts` |
| F11 | 参考项目 pi-dynamic-workflows 的 agent frontmatter 同样声明了 `mcp` 字段但 "Parsed-but-ignored" —— 子代理 MCP 接入是同类项目共同空白点 | `thirdparties/pi-dynamic-workflows/src/agent-registry.ts:21` |
| F12 | `toolExposure` key 支持通配符模式（`*` 匹配任意字符）；**精确名优先于模式，模式间首个匹配获胜**；`hidden` 直接移除工具。官方原话给出目标范式：`"exposure": "hidden"` 加少量工具覆盖 = 只开放那些工具 —— 「默认隐藏、显式开放」无需枚举全部工具 | `dist/core/mcp-servers.d.ts:32-38`（v3 评审触发新增） |

**结论：原方案的三个核心前提（SDK API 存在、显式装配可行、noExtensions 可保持）全部实证通过。**

---

## 二、M0 剩余实证项（运行时行为，需真实执行验证）

F1-F12 是静态事实；F13-F18 为 M0 运行时实证新增（见执行报告），以下 6 项运行时行为已全部跑通（2026-11-18）。
统一放 `dev-examples/mcp-m0-verification/`（沙盒，验证通过后按 CLAUDE.md 毕业路径处理）。

### M0-1：显式装配 + 递归防护共存

- 改造 `PiAgentAdapter`（临时副本）：`noExtensions: true` 不变，追加 `extensionFactories: [createMcpExtension({loadConfig}), createCodemodeExtension(), createToolSearchExtension()]`。
- 验证：子会话能列出 MCP 工具（`session.getActiveToolNames()` 含 `mcp__*`），同时宿主其他扩展零加载（对照现有 recursive-guard 测试）。
- **验收标准**：磁盘扩展路径数 = 0；`mcp__*` 工具按策略出现；`bindExtensions({})` 在 `prompt()` 前调用且不报错。

### M0-2：`loadConfig` 注入过滤（server 级 + 工具级）

- 自定义 `loadConfig` 返回过滤后的 `LoadedMcpConfig`（只保留策略允许的 server，逐工具 exposure 覆盖）。
- 验证：不在策略内的 server 不连接（日志无该 server 启动记录）；`autoEnableCodemode` 行为符合预期。
- **评审补充（P0）：工具级授权独立生效**——同一 server 连接的情况下，`allowTools` 只放行部分工具，
  验证未授权工具被映射为 `toolExposure: "hidden"` 后模型声明中不可见、direct 声明不含它。
  即「server 白名单 ≠ 工具白名单」两条过滤各自独立生效。
- **评审补充（P0，v3）：策略叠加反向测试**——server 级 `exposure: "direct"` 且某工具被 deny 时，
  验证该工具仍 hidden（官方语义：工具 exposure 取 `toolExposure` 条目，否则回落 server `exposure`，
  即 `getMcpToolExposure`，`mcp-servers.d.ts:111`）。验证的是叠加而非正常路径。
- **评审补充（P1，v4）：通配符经真实 server 实测**——`allowTools` 模式转换后的 `toolExposure` key
  在真实工具名上验证匹配行为（首个匹配获胜、精确名优先），不只靠策略层字符串单测（矩阵见 M1 验收）。
- **验收标准**：策略过滤后的工具集合与预期完全一致（含工具级 allow/deny 交集、deny 压过 server direct）；`errors` 数组正确透传配置错误。

### M0-3：工具管线权限拦截实测

- 给子会话注册一个 `beforeToolCall` 钩子拒绝某个 `mcp__*` 工具；再跑一个 codemode 脚本尝试调用同一工具。
- **验收标准**：直接调用与 codemode 脚本内调用都被拦截，且拦截事件都出现在工具管线事件流中（验证 F9，不出现绕过通道）。

### M0-4：并行会话连接生命周期（原方案风险点 2 的实证）

对照实验矩阵（评审补充后共 6 组，stdio 4 组 + HTTP 2 组）：

| 实验 | 目的 |
|---|---|
| 4 Session + stdio 同一 server | 验证每 session 独立进程（预期进程数 = 4） |
| 4 Session + HTTP 同一远端 | 验证共享远端服务（连接/会话对象仍是每 session 独立，需确认） |
| 4 Session 并发调用同一工具 | 验证并发隔离与结果不串扰 |
| 关闭其中 1 个 Session | 验证其余 Session 连接不受影响 |
| 全部 dispose | 验证 stdio 进程全部回收、无僵尸 |
| HTTP server 401/OAuth 缺凭证时的报错路径 | 验证失败不阻塞其他 server 连接 |

- **验收标准**：stdio 进程数 = 会话数、无僵尸进程、无跨会话串扰、单 session 关闭不影响他者；
  HTTP 模式确认「远端服务可共享但 pi 侧连接对象不跨 session 共享」的生命周期语义并记录结论。
  第一阶段不实现连接池。若 stdio 成本不可接受，在 M2 中按现有并发上限（CLAUDE.md：长联调 ≤2 并发）
  自然限流，并在文档中注明「重量级共享 server 应改用 Streamable HTTP 部署」。

### M0-5：exposure 四模式实测（含 hidden 不可达）

- 同一 server 配置各 exposure 工具，验证：`direct` 出现在工具声明、`codemode` 只能脚本内 `searchTools()` 找到并调用、`deferred` 经 `tool_search` 按需加载。
- **评审补充（P0）：hidden 彻底不可达**——被 `toolExposure: "hidden"` 的工具，验证模型声明不含它、
  codemode `searchTools()` 搜不到、脚本内直接 `tools.mcp__<server>__<tool>()` 调用报错。
  hidden 是 M1 工具级拒绝的实现机制，若存在任一绕过通道，M1 设计需重评。
- **验收标准**：四种模式的模型可见性与调用路径与扩展文档描述一致；hidden 无任何调用通道。

### M0-6：Journal 可观测范围实测（评审补充，静态结论已先行完成）

静态验证已完成（2026-11-17，评审意见触发）：现有 journal entry 只含 `{hash, result, sessionId,
usage?, executions[]}`，`AgentExecutionResult` 只携带 `{type, value, sessionId}`——**不含任何工具调用记录**；
且子会话用 `SessionManager.inMemory()` 不落盘（`pi-agent-adapter.ts:78`），run 结束后工具调用完全不可观测。
运行时补测两项：

1. 实跑一个带 MCP 工具调用的 agent，确认 journal entry 与快照中确实无工具级条目（把静态结论钉死）。
2. 枚举 `session.subscribe` 事件流中的工具事件类型与载荷，确认 Adapter 能拿到工具名/参数/结果/错误/耗时
   ——这是 M2 最小审计记录方案的数据前提。

- **验收标准**：M0 执行报告中明确现有可观测范围（agent 级结果 + usage，无工具级）；
  事件流载荷清单足以支撑 M2 的 `mcp__*` 调用记录实现，或明确列出不满足项。

**M0 交付物**：`dev-docs/progress-result/MCP-M0-执行报告.md`（实证脚本、运行证据、结论），并把结论回填本文档第一节。

**M0 明确不做**：OAuth 流程实证（首期只用 stdio/带 header 的 HTTP）；`/mcp` 交互面板（子会话无 TUI）；cloudflare worker 版 codemode。

---

## 三、M1（修订版）：MCP 策略层（薄）

**模块**：`src/mcp/mcp-policy.ts`（单文件起步，不建五个模块）。

```ts
// 输入：默认配置 + Agent 策略；输出：过滤后的 LoadedMcpConfig
export interface McpPolicy {
  enabled: boolean;
  servers?: string[];              // server 白名单；undefined = 拒绝全部（默认拒绝原则）
  allowTools?: string[];           // 工具白名单，规范名 "<server>:<tool>"，"<server>:*" 全量，支持通配符
  denyTools?: string[];            // 工具黑名单，规范名同上；优先级高于 allowTools
  exposure?: Record<string, McpExposure>;  // per-server 覆盖
}
```

**权限三条铁律**（评审补充，M0-2/M0-5 实证）：

1. **Server 授权 ≠ 工具授权；默认隐藏、显式开放（v3 锁定生成规则）**：`servers` 只控制是否连接。
   工具不可在配置阶段枚举（工具是连接后动态发现的），因此拒绝用「逐工具列 hidden」实现默认拒绝，
   改用 F12 的官方范式：`filterMcpConfig` 产出规则——
   - server 级 `exposure` 默认写 `"hidden"`（policy.exposure 有显式覆盖时用覆盖值）；
   - `allowTools` 展开（去掉 `<server>:` 前缀，取 server 视角裸工具名）写入 `toolExposure`，
     显式名条目在前、`"xxx_*"` 模式条目在后，exposure 值取 `policy.exposure[server] ?? "codemode"`；
   - `denyTools` 展开为**精确名 hidden 条目置于 `toolExposure` 首位**——官方语义「精确名赢过模式、
     模式间首个匹配获胜」保证 deny 恒压过 allow（含模式误匹配场景）与 server exposure；
   - 未被 allow 命中的工具继承 server 默认 hidden，无需枚举（F12 原话：`"exposure": "hidden"` 加少量覆盖 = 只开放那些）。
2. **deny 优先于 allow**：由铁律 1 的 toolExposure 排列顺序结构化保证，不依赖遍历后过滤。
3. **结构层匹配，永不解析字符串**：`filterMcpConfig` 拿到的 `LoadedMcpConfig.servers[]` 本身就是
   结构化数据（server entry + 配置），allow/deny 匹配直接在该结构上做；
   不解析 `mcp__<server>__<tool>` 拼接名，从结构上消除 server 名含下划线/特殊字符的解析歧义
   （不引入独立 McpToolIdentity 类型——`McpServerEntry` + 工具名已是结构化形态）。
   `mcp__*` 拼接名只出现在 session 层 `excludeTools`（SDK 原生约定），见 M2 优先级规则。

```ts
export function filterMcpConfig(
  base: LoadedMcpConfig,
  policy: McpPolicy,
): LoadedMcpConfig
```

- 配置来源直接复用 `loadMcpConfig()`（F8），**不另造配置格式**——用户在宿主里配好的 `~/.pi/agent/mcp.json` 与项目 `.pi/mcp.json` 直接生效。
- 默认拒绝：`enabled: true` 且 `servers` 未配置时返回空集，而非全集。
- 每个会话创建独立的 `createMcpExtension({ loadConfig: ... })` 实例（工厂是无状态函数，可多次调用；M0-4 同时验证多实例成本）。
- **验收标准**：`tests/contract/mcp-policy.test.ts` 覆盖六个行为：server 白名单/工具 allow 展开/deny 置首
  （含 deny 压过 server direct 与模式误匹配）/通配符/默认拒绝（空集 + server 默认 hidden）/空策略；无模型依赖，纯函数可测。
- **通配符两层交叉测试矩阵（评审 v4 P1）**：策略层只做「规范名 → toolExposure key」转换
  （剥 `<server>:` 前缀，取第一个冒号），匹配全部由 pi 执行——测试覆盖转换边界与 pi 匹配两层：

  | 用例 | 预期 |
  |---|---|
  | 精确工具名 `game-server:get_rules` | 仅该工具开放 |
  | `game-server:*` | 该 server 全部工具开放 |
  | `game-server:get_*` | 前缀匹配工具开放 |
  | 特殊字符工具名（含 `-` `.` `_` 等） | 前缀剥离与转换正确 |
  | deny 精确名 + allow 通配符重叠 | deny 生效（精确名赢过模式，官方语义） |
  | allow 两条重叠模式 | 排列顺序决定首个匹配获胜，deny 条目恒在前 |

  M0-2 联调实测用真实 server 工具名验证，不只靠字符串单元测试。

## 四、M2：AgentAdapter 接入

### 类型扩展（`src/adapter/types.ts`）

```ts
interface ToolPolicy {
  excludeTools?: string[];
  noExtensions?: boolean;
  allowTools?: string[];
  mcp?: McpPolicy;   // 即第三节的结构，字段语义不变
}
```

### `PiAgentAdapter` 改造点

1. `policy.mcp?.enabled` 为 true 时，向 `DefaultResourceLoader` 追加三个工厂（`noExtensions` 保持现状不动，依赖 F4 的实现事实）。
2. `loadConfig` 闭包捕获该 Agent 的 `McpPolicy`，经 `filterMcpConfig` 注入。
3. `session.bindExtensions({})` 在首次 `prompt()` 前调用（F5）；对无 MCP 的会话维持现有路径零改动。
4. `codemode`/`tool_search` 的激活交给 MCP 扩展按 exposure 自动处理（F5），Adapter 不手工 `setActiveTools`，避免双写。
5. **DSL 透传链路补齐（评审 v3 P0-1，源码已证实断点）**：评审断言经逐文件验证属实——
   `AgentRequest.tools` 存在（`adapter/types.ts:22`）、`PiAgentAdapter` 已消费（`pi-agent-adapter.ts:83-84`），
   但中间两环缺失：`ScriptAgentOptions` 无 tools（`workflow-runtime.ts:61-86`）、
   `AgentRunOptions` 无 tools（`session-runner.ts:16-32`）、`agentAdapterToRunner()` 构造 request 时
   丢弃 tools（`agent-adapter.ts:55-61`，只透传 prompt/model/cwd/outputSchema/signal）。
   **不补则集成测试直调 Adapter 全绿、workflow 脚本实际调用时 tools.mcp 静默丢失。**
   补齐三处：`ScriptAgentOptions.tools?: ToolPolicy` → `AgentRunOptions.tools?: ToolPolicy` →
   request 构造加 `tools: options?.tools`。不改 Runtime 执行语义，纯配置沿现有调用链下传。
6. **两层权限的优先级规则（评审补充，P0）**：`mcp` policy 在 loadConfig 层做硬过滤（结构层，hidden 工具不可达），
   现有 `allowTools`/`excludeTools` 在 session 层按 SDK 语义过滤工具声明（含 `mcp__*` 名）。两层叠加、
   **更严者胜**：任一层拒绝即不可用，不存在某层放开另一层拒绝的工具。文档口径：mcp policy 是
   MCP 专用授权面，session 层白/黑名单是通用兜底，两者职责不合并。
7. **`mcp__*` 工具调用写入 journal（v4 P0 锁定失败路径：事件侧实时上报）**：现状 journal 无任何
   工具级记录（M0-6 静态结论），且数据通道四环均缺字段。**v4 关键修正：失败路径不能走结果侧**——
   `throwForStatus`（`agent-adapter.ts:19,81`，`:never` 签名）在 status 非 ok 时直接抛异常，
   结果对象（含未来加的 `AgentResult.toolCalls`）整体被丢弃；取消/超时同样拿不到返回值。
   因此采评审方案 A：**工具调用记录走事件侧实时上报，与 attempt 终态解耦**。
   通道设计（基础设施均已存在，只补窄桥接；**v5 修正：executionId 由 Runtime 注入，不再自造**）：
   ```
   Workflow Runtime（executionId = `${deltaKey}:${attempt}`，workflow-runtime.ts:562）
     -> AgentRunOptions 新增 executionId（Runtime 注入内部字段，workflow 脚本不可见不可指定）
        与 onToolCall 窄回调；agentAdapterToRunner 的 ctx.executionId 改用注入值
        （现状 :53 自造 randomUUID 与 Runtime ID 体系分裂——v5 断点；保守 fallback：
        options 缺省时保留 randomUUID 兼容其他调用方）
   PiAgentAdapter（subscribe 采集 mcp__* 调用，调一次报一次）
     -> ctx.onEvent({ type: "record", executionId, record: { kind: "mcp-tool-call", ... } })
        （AgentEvent.record 通用变体现成，types.ts:58；ExecutionContext.onEvent 现成，types.ts:35）
     -> agentAdapterToRunner 经 chainOnEvent 桥接到 options.onToolCall
        （chainOnEvent 现成，agent-adapter.ts:100）
     -> Workflow Runtime 按 executionId 收集（同一 ID 体系，重试不混淆新旧 attempt）
     -> 分流落盘：
          成功 attempt -> JournalEntry.toolCalls（append 路径，workflow-runtime.ts:627）
          失败/中止 attempt -> AgentExecutionRecord.toolCalls（executions[]，recordExecution 路径）
   ```
   **迟到事件与竞态细则（v5 P1）**：Runtime 按 executionId 分缓冲（每 attempt 独立）；attempt 终结时
   冻结快照落盘；迟到事件因 executionId 不同天然不会写入下一次 attempt，对已冻结缓冲直接丢弃并计数。
   start/end 事件经工具调用 ID 配对，只记终态一条防重复计数；attempt 终结时未配对的 start 记为
   cancelled。事件形态（start/end 是否成对、超时后底层 Session 是否真正停止）以 M0-6 实测为准。
   **P1 备选（成功 attempt 历史归属）**：成功 attempt 的 toolCalls 同步经 recordExecution 写入
   executions[]（journal.ts:59 已有同 executionId 去重），Node Inspector 可展示完整重试历史；
   JournalEntry.toolCalls 仍只存最新成功摘要。实现成本低则默认做，验收不强制。
   失败/取消/超时的已发生 MCP 调用经事件流实时送达 Runtime，再经 executions[] 保留，
   与 attempt 终态无关。记录内容收紧为**安全摘要**（v3 P1-1，见风险表）：工具名/状态/耗时/
   参数字节数与脱敏后键名列表，**不存完整参数、不存返回值**；错误信息经脱敏与限长。
   不引入独立 McpCallRecord 类型——工具名 `mcp__` 前缀已可辨来源；非 MCP 工具调用本期不记录。

### DSL 侧（workflow `agent()` 参数）

透传 `tools.mcp`（`AgentRequest` 已定义 tools 字段；本次 M2 补齐从 Workflow DSL 到 AgentRequest 的传递链路，
见改造点 5），workflow 脚本即可写：

```js
const result = await agent({
  label: "服务端规则检查",
  prompt: "检查当前麻将规则与服务端实现",
  tools: { mcp: { enabled: true, servers: ["game-server"], allowTools: ["game-server:*"] } },
});
```

- **验收标准**：
  - 契约测试：policy 含 `mcp` 时 loader 工厂装配正确、不含时与现状逐字节一致（回归保护）。
  - **透传链端到端测试（v3 P0-1，P0 级）**：用例必须从 **workflow 脚本**发起（`agent({ tools: { mcp } })`），
    逐环节断言 tools 到达 PiAgentAdapter；禁止只用「直调 `PiAgentAdapter.execute()`」充当透传证据——
    那条路径绕过了本次补齐的三个断点。
  - 联调测试（遵守并发 ≤2、看门狗、证据落盘纪律）：真实 MCP server（建议用 `@modelcontextprotocol/server-filesystem` 或仓库内已有测试 server）经 codemode 被 Agent 调用成功；拒绝策略生效（含 deny 压过 server direct 的反向用例）；
    journal 落盘验证双路径：成功 attempt 的 `toolCalls[]` 与**失败/超时/取消 attempt** 的 `executions[].toolCalls`
    均含 `mcp__*` 摘要（名称/状态/耗时，无完整参数），且重试的新旧 attempt 调用不混录；
    两层权限叠加语义（更严者胜）有显式测试用例。

---

## 五、本期明确不做（M3/M4 方向，另行立项）

- `tool_search` deferred 模式的深度调优（M0-5 只验证行为存在）。
- Workflow 直调 MCP（`mcp.call()` 注入 VM）：pi-mcp 的 `McpClient`（F10）证明技术可行，但副作用工具的 Replay Policy 语义需要独立设计，不混入本期。
- MCP 调用的独立 Journal 记录类型（`McpCallRecord`）：本期以轻量 `toolCalls[]` 字段满足审计需求（M2 改造点 7），
  独立类型与副作用 Replay Policy 联动留给 M4。~~本期复用现有工具调用记录~~（原表述有误，2026-11-17 修正：
  经实证现有 journal 不含任何工具调用记录，子会话 inMemory 不落盘，见 M0-6）。
- 人工审批（human-in-the-loop）工作流。

---

## 六、风险与注意事项

| 风险 | 应对 |
|---|---|
| 每会话独立连接导致 stdio 进程数随并发膨胀 | M0-4 实测定量；短期靠现有并发上限限流，文档建议重量级 server 走 HTTP 部署 |
| `bindExtensions` 时机不对导致 MCP 未连接就 prompt | M0-1 验收标准显式覆盖；改造时在 Adapter 内固定调用顺序 |
| 宿主用户 mcp.json 里配置了不安全 server，被某个 Agent 策略意外放开 | 默认拒绝原则（第三节）；契约测试覆盖空策略返回空集 |
| noExtensions 语义在未来 SDK 版本变化（F4 是实现细节而非文档承诺） | 升级依赖时跑 M0-1 回归；契约测试固化「工厂已装配 + 磁盘扩展为零」两条断言 |
| codemode VM（QuickJS/WASM）与现有 workflow VM（node vm）混淆 | 文档口径固定：两者并存不同层，workflow VM 不获得 MCP 能力（M4 才考虑，且走 Runtime 受控代理） |
| MCP 工具返回内容被当作可信指令（prompt injection）（评审补充） | 文档口径固定：工具返回一律视为不可信外部数据，仅作数据消费；工具结果不得变更 Agent 权限、不得为其他 MCP 工具授权；M0-3 的管线拦截验证是执行层兜底 |
| 凭证泄露（评审补充） | 凭证继续走 SDK 原生路径（`mcp-auth.json`、env 展开的 header、OAuth），不复制进 policy/journal/日志。**v3 P1-1 收紧：`redactValue` 不作为安全脱敏器**——它是展示用途（`agent-result.ts` 头注释自述），且递归超深度上限（4 层）直接返回原值，深层敏感子树原样保留；键名匹配也识别不了字符串形态的凭证。`toolCalls[]` 落盘规则：只存工具名/状态/耗时/参数字节数/脱敏后键名列表，**不存完整参数与返回值**；错误信息脱敏后限长（复用 truncateUtf8ByBytes）。若后续需要完整参数审计，另建专用安全模块，不复用展示层实现 |

---

## 七、里程碑状态表

| 里程碑 | 状态 | 交付物 |
|---|---|---|
| M0 静态实证（F1-F12） | **已完成**（本文档第一节） | 本文档 |
| M0 运行时实证（M0-1 ~ M0-6） | **已完成**（2026-11-18，57 断言全 PASS） | `dev-examples/mcp-m0-verification/` + `dev-docs/progress-result/MCP-M0-执行报告.md` |
| M1 MCP 策略层（薄） | **已完成**（2026-11-18，14 契约断言） | `src/mcp/mcp-policy.ts` + `tests/contract/mcp-policy.test.ts` |
| M2 AgentAdapter 接入 | **已完成**（2026-11-18，契约 81/引擎 206/端到端 19 断言全 PASS） | `MCP-M2-执行报告.md`（类型扩展 + PiAgentAdapter 改造 + runtime 双落点 + e2e） |
| M3/M4 | M4 直调核心已完成（2026-11-18）；M3 与 M4 剩余项另行立项 | `src/mcp/mcp-client-pool.ts` + `MCP-M4-执行报告.md` |

## 引用

- pi-coding-agent 1.3.0 本地安装副本：`node_modules/@earendil-works/pi-coding-agent/dist/`（index.d.ts、core/resource-loader.js、extensions/mcp/*、docs/sdk.md、examples/sdk/14-codemode-mcp.ts）
- pi-mcp 1.3.0：`node_modules/@earendil-works/pi-mcp/dist/index.d.ts`
- pi 官方仓库 MCP/Codemode 包：https://github.com/earendil-works/pi/tree/main/packages/mcp 、https://github.com/earendil-works/pi/tree/main/packages/codemode
- 官方 MCP + Codemode 示例：https://github.com/earendil-works/pi/tree/main/examples
- 本仓库参考项目：`thirdparties/pi-dynamic-workflows`（agent frontmatter `mcp` 字段 parsed-but-ignored 的同类先例）
