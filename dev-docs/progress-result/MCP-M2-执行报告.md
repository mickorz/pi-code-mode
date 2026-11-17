# MCP-M2 执行报告：MCP 策略层 + AgentAdapter 接入

- 日期：2026-11-18
- 对应计划：`dev-docs/planning/2026-11-17-mcp-integration-执行计划.md`（v5）
- 结论：**M1 + M2 全部完成**——契约 81 断言、引擎 206 断言、tsc 类型关卡全绿；端到端联调 3 用例 19 断言全 PASS
- 前置：M0 运行时实证（`MCP-M0-执行报告.md`，57 断言）

---

## 一、M1：MCP 策略层（薄）

| 交付物 | 说明 |
|---|---|
| `src/mcp/mcp-policy.ts` | `McpPolicy` 接口 + `filterMcpConfig(base, policy)` 纯函数 + `splitToolSpec` 规范名解析 |
| `tests/contract/mcp-policy.test.ts` | 14 断言：默认拒绝/server 白名单/工具级独立生效/deny 压 direct/键序矩阵/通配符透传/非法规范名/base 元数据保留 |

三铁律落地：
1. **默认拒绝**：`enabled=false` 或 `servers` 未配置 → 空集；`allowTools` 未命中的工具继承 server `exposure: "hidden"`（F12 官方范式，不枚举工具）。
2. **deny 恒胜**：toolExposure 键按 `[deny 精确名][allow 精确名][deny 模式][allow 模式]` 构建 + **先到先得去重**（同键 deny 恒赢，含 deny 模式与 allow 模式同字符串的场景——测试中发现并修复的后写覆盖 bug）。
3. **结构层匹配**：全程在 `McpServerEntry` 结构上操作；`<server>:<tool>` 规范名按第一个冒号切分。

## 二、M2：AgentAdapter 接入（P0-1 透传链 + 事件通道 + journal 双落点）

| 文件 | 改造 |
|---|---|
| `src/engine/types/index.ts` | 新增 `McpPolicy` / `McpToolCallSummary`（安全摘要契约）；`JournalEntry.toolCalls?` / `AgentExecutionRecord.toolCalls?`（双落点字段） |
| `src/adapter/types.ts` | `ToolPolicy.mcp?: McpPolicy`（引用 engine/types，依赖方向 engine←adapter 不反转） |
| `src/engine/agent/session-runner.ts` | `AgentRunOptions` 新增 `executionId`（v5 Runtime 注入）/ `tools`（P0-1）/ `onToolCall`（事件侧窄回调） |
| `src/adapter/agent-adapter.ts` | bridge：executionId 贯通（缺省 fallback UUID 兼容旧调用方）+ tools 透传 request + record(`mcp-tool-call`) 事件桥接 onToolCall |
| `src/adapter/pi-agent-adapter.ts` | `mcp.enabled` 时装配三工厂（MCP/Codemode/ToolSearch，`noExtensions` 保持不变，F4）；`makeMcpLoadConfig` 注入过滤配置；prompt 前 `bindExtensions({})`（F5 顺序）；session.subscribe 采集 `tool_execution_start/end` 组装安全摘要（不存完整参数/返回值，错误经 redact+限长）；取消/超时路径 flush 未配对 start 为 error 摘要 |
| `src/engine/runtime/workflow-runtime.ts` | `ScriptAgentOptions.tools`（计入 hash 身份）；attempt 级 `mcpCalls` 缓冲 + `executionId` 注入 + `onToolCall` 收集；成功 → `JournalEntry.toolCalls`、失败/中止 → `AgentExecutionRecord.toolCalls`（v4/v5 双落点） |
| `src/mcp/mcp-config-loader.ts` | pi 1.3.0 的 `loadMcpConfig` 未从包主入口导出——按官方 override 语义实现最小等价读取（全局+项目合并） |
| `tests/contract/mcp-bridge.test.ts` | 8 断言：executionId 贯通/缺省 fallback/tools 透传/onToolCall 桥接/runtime 双落点/hash 身份 |

## 三、端到端联调（真实模型 glm-5.3-flash + stdio fixture + 完整 workflow 链路）

脚本：`dev-examples/mcp-m2-e2e/e2e.ts`；隔离：`PI_CODING_AGENT_DIR` 临时目录（复制凭证 + fixture 专用 mcp.json，不触碰宿主配置）。

| 用例 | 断言 | 结果 | 关键证据 |
|---|---|---|---|
| E2E-1 放行 | 8 | PASS | workflow 输出含 marker；调用到达 server；**journal `entry.toolCalls[0]` = `{toolName: "mcp__fix__echo", status: "ok", durationMs: 23, argsKeys: ["text"]}`** |
| E2E-2 拒绝 | 2 | PASS | denyTools 压过 allowTools；调用未到达 server；模型报告不可调用 |
| E2E-3 默认拒绝 | 3 | PASS | 未授权 server 零连接零进程；模型确认工具不可用 |

## 四、测试与构建汇总

- `npm run build`：通过（tsc 类型关卡）
- `npm run test:contract`：81/81（含 mcp-policy 14 + mcp-bridge 8 新增）
- `npm run test:engine`：206/206（零回归）

## 五、发现与注意事项

1. **宿主 packages 冷启动开销**：子会话隔离目录复制宿主 settings.json 时，`packages` 字段会触发逐包 git clone + npm install（实测 12 包 ≈200s）。**M2 实现不受影响**（生产路径读宿主原目录，包已安装）；仅影响沙盒型隔离脚本——e2e 已剥 packages 字段。
2. **pi 1.3.0 `loadMcpConfig` 未导出**：SDK 主入口只导出类型不导出读取函数；`mcp-config-loader.ts` 按官方文档语义实现（override 合并规则），升级 SDK 时需对照校验。
3. **事件流实测载荷**：`tool_execution_start = {toolCallId, toolName, args}`、`tool_execution_end = {toolCallId, toolName, result, isError, durationMs}`——McpToolCallSummary 的安全摘要（argsBytes/argsKeys/status/durationMs）全部可从事件流取得，无需触碰 result 内容。
4. M0 报告的两项 WARN 在 M2 的落点：F15（dispose 不回收 stdio 进程）——本期未在 Adapter 层加补偿清理（脚本退出管道断裂自然回收，长驻进程场景留待上游修复或后续迭代）；F16（401 阻塞）——由 loadConfig 默认拒绝天然防御（未授权 server 根本不进配置）。

## 六、遗留

- `tool_search` deferred 模式的 e2e 覆盖（本期 e2e 用 direct/codemode 路径；deferred 行为已在 M0-5C 实证）
- dispose 泄漏的长驻进程补偿（见第五节第 4 条）
- 上游反馈：F15（dispose 不回收）、`loadMcpConfig` 未导出（读取逻辑被迫自实现）——可作为 pi 上游 issue 反馈
