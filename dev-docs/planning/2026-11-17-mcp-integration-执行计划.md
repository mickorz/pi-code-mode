# pi-code-mode：MCP Tool Integration 执行计划

- 日期：2026-11-17
- 状态：M0 大部分实证已完成（本文档第一节），剩余实证项已锁定
- 范围：本期只做 M0 + M1 + M2（Agent 调用 MCP），M3/M4 列为后续方向不展开
- 上游方案：ChatGPT 调研稿（2026-11-17），经本仓库独立验证后修订

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

**结论：原方案的三个核心前提（SDK API 存在、显式装配可行、noExtensions 可保持）全部实证通过。**

---

## 二、M0 剩余实证项（运行时行为，需真实执行验证）

F1-F11 是静态事实，以下 5 项是运行时行为，必须写实证脚本跑通后才允许进入 M1/M2。
统一放 `dev-examples/mcp-m0-verification/`（沙盒，验证通过后按 CLAUDE.md 毕业路径处理）。

### M0-1：显式装配 + 递归防护共存

- 改造 `PiAgentAdapter`（临时副本）：`noExtensions: true` 不变，追加 `extensionFactories: [createMcpExtension({loadConfig}), createCodemodeExtension(), createToolSearchExtension()]`。
- 验证：子会话能列出 MCP 工具（`session.getActiveToolNames()` 含 `mcp__*`），同时宿主其他扩展零加载（对照现有 recursive-guard 测试）。
- **验收标准**：磁盘扩展路径数 = 0；`mcp__*` 工具按策略出现；`bindExtensions({})` 在 `prompt()` 前调用且不报错。

### M0-2：`loadConfig` 注入过滤

- 自定义 `loadConfig` 返回过滤后的 `LoadedMcpConfig`（只保留策略允许的 server，逐工具 exposure 覆盖）。
- 验证：不在策略内的 server 不连接（日志无该 server 启动记录）；`autoEnableCodemode` 行为符合预期。
- **验收标准**：策略过滤后的工具集合与预期完全一致；`errors` 数组正确透传配置错误。

### M0-3：工具管线权限拦截实测

- 给子会话注册一个 `beforeToolCall` 钩子拒绝某个 `mcp__*` 工具；再跑一个 codemode 脚本尝试调用同一工具。
- **验收标准**：直接调用与 codemode 脚本内调用都被拦截，且拦截事件都出现在工具管线事件流中（验证 F9，不出现绕过通道）。

### M0-4：并行会话连接复用语义（原方案风险点 2 的实证）

- 并发起 4 个子会话，全部配置同一个 stdio server。
- 验证：实际 stdio 进程数（预期为 4，每 session 独立连接）；并发调用是否互相干扰；dispose 后进程是否全部回收。
- **验收标准**：进程数 = 会话数；无僵尸进程；无跨会话串扰。若成本不可接受，在 M2 中按现有并发上限（CLAUDE.md：长联调 ≤2 并发）自然限流，并在文档中注明「重量级共享 server 应改用 Streamable HTTP 部署」。

### M0-5：exposure 三模式实测

- 同一 server 配置三种 exposure 各一个工具，验证：`direct` 出现在工具声明、`codemode` 只能脚本内 `searchTools()` 找到并调用、`deferred` 经 `tool_search` 按需加载。
- **验收标准**：三种模式的模型可见性与调用路径与扩展文档描述一致。

**M0 交付物**：`dev-docs/progress-result/M0-执行报告.md`（实证脚本、运行证据、结论），并把结论回填本文档第一节。

**M0 明确不做**：OAuth 流程实证（首期只用 stdio/带 header 的 HTTP）；`/mcp` 交互面板（子会话无 TUI）；cloudflare worker 版 codemode。

---

## 三、M1（修订版）：MCP 策略层（薄）

**模块**：`src/mcp/mcp-policy.ts`（单文件起步，不建五个模块）。

```ts
// 输入：默认配置 + Agent 策略；输出：过滤后的 LoadedMcpConfig
export interface McpPolicy {
  enabled: boolean;
  servers?: string[];              // 白名单；undefined = 拒绝全部（默认拒绝原则）
  allowTools?: string[];           // mcp__<server>__<tool> 或 <server>:<tool> 形式，支持通配符
  denyTools?: string[];
  exposure?: Record<string, McpExposure>;  // per-server 覆盖
}

export function filterMcpConfig(
  base: LoadedMcpConfig,
  policy: McpPolicy,
): LoadedMcpConfig
```

- 配置来源直接复用 `loadMcpConfig()`（F8），**不另造配置格式**——用户在宿主里配好的 `~/.pi/agent/mcp.json` 与项目 `.pi/mcp.json` 直接生效。
- 默认拒绝：`enabled: true` 且 `servers` 未配置时返回空集，而非全集。
- 每个会话创建独立的 `createMcpExtension({ loadConfig: ... })` 实例（工厂是无状态函数，可多次调用；M0-4 同时验证多实例成本）。
- **验收标准**：`tests/contract/mcp-policy.test.ts` 覆盖白名单/黑名单/通配符/默认拒绝/空策略五行 为；无模型依赖，纯函数可测。

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

### DSL 侧（workflow `agent()` 参数）

透传 `tools.mcp`（AgentRequest 已有 tools 字段透传链路），workflow 脚本即可写：

```js
const result = await agent({
  label: "服务端规则检查",
  prompt: "检查当前麻将规则与服务端实现",
  tools: { mcp: { enabled: true, servers: ["game-server"], allowTools: ["game-server:*"] } },
});
```

- **验收标准**：
  - 契约测试：policy 含 `mcp` 时 loader 工厂装配正确、不含时与现状逐字节一致（回归保护）。
  - 联调测试（遵守并发 ≤2、看门狗、证据落盘纪律）：真实 MCP server（建议用 `@modelcontextprotocol/server-filesystem` 或仓库内已有测试 server）经 codemode 被 Agent 调用成功；拒绝策略生效；journal 中工具调用记录含 `mcp__*` 条目。

---

## 五、本期明确不做（M3/M4 方向，另行立项）

- `tool_search` deferred 模式的深度调优（M0-5 只验证行为存在）。
- Workflow 直调 MCP（`mcp.call()` 注入 VM）：pi-mcp 的 `McpClient`（F10）证明技术可行，但副作用工具的 Replay Policy 语义需要独立设计，不混入本期。
- MCP 调用的独立 Journal 记录类型：本期复用现有工具调用记录（`mcp__*` 天然出现在 AgentSession 工具事件流中，随 Agent result 入 journal），独立的 `McpCallRecord` 留给 M4。
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

---

## 七、里程碑状态表

| 里程碑 | 状态 | 交付物 |
|---|---|---|
| M0 静态实证（F1-F11） | **已完成**（本文档第一节） | 本文档 |
| M0 运行时实证（M0-1 ~ M0-5） | 未开始 | 实证脚本 + `M0-执行报告.md` |
| M1 MCP 策略层（薄） | 未开始 | `src/mcp/mcp-policy.ts` + 契约测试 |
| M2 AgentAdapter 接入 | 未开始 | 类型扩展 + PiAgentAdapter 改造 + 联调证据 |
| M3/M4 | 不在本期 | 另行立项 |

## 引用

- pi-coding-agent 1.3.0 本地安装副本：`node_modules/@earendil-works/pi-coding-agent/dist/`（index.d.ts、core/resource-loader.js、extensions/mcp/*、docs/sdk.md、examples/sdk/14-codemode-mcp.ts）
- pi-mcp 1.3.0：`node_modules/@earendil-works/pi-mcp/dist/index.d.ts`
- pi 官方仓库 MCP/Codemode 包：https://github.com/earendil-works/pi/tree/main/packages/mcp 、https://github.com/earendil-works/pi/tree/main/packages/codemode
- 官方 MCP + Codemode 示例：https://github.com/earendil-works/pi/tree/main/examples
- 本仓库参考项目：`thirdparties/pi-dynamic-workflows`（agent frontmatter `mcp` 字段 parsed-but-ignored 的同类先例）
