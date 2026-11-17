# MCP-M0 执行报告：MCP 集成运行时实证

- 日期：2026-11-18
- 对应计划：`dev-docs/planning/2026-11-17-mcp-integration-执行计划.md`（v5）
- 说明：与 2026-11-14 的 `M0-执行报告.md`（项目早期里程碑：技术验证与接口锁定）为**不同里程碑**，本报告是 MCP Tool Integration 阶段的 M0
- 结论：**M0-1 ~ M0-6 全部通过（57 条断言，0 失败，2 项 WARN 记录 SDK 行为发现）**
- 实证脚本：`dev-examples/mcp-m0-verification/`（fixture + 8 个脚本 + results/*.json 证据）
- 运行方式：`cd dev-examples/mcp-m0-verification && npx tsx <脚本>`；模型用例走宿主默认 provider（cc-switch-zhipu-glm / glm-5.3-flash），预热通过（`m0-warmup.json`）

---

## 一、结果总表

| 实证项 | 断言数 | 结果 | 关键结论 |
|---|---|---|---|
| 预热（模型可用） | 2 | PASS | glm-5.3-flash 经 SDK 会话正常往返 |
| M0-1 装配 + 递归防护 | 10 | PASS | 磁盘扩展零加载（全 `<inline:N>`）；`mcp__fix__*` 4 工具按策略出现；命名规范确认 |
| M0-2 loadConfig 过滤（A/B/C） | 10 | PASS | server 白名单生效（未授权进程零启动）；工具级授权独立生效；deny 压过 server direct |
| M0-3 管线拦截（A/B 双路径） | 7 | PASS | direct 直调与 codemode 脚本内调用均被 block，调用均未到达 server；codemode 嵌套调用带 `parentToolCallId` |
| M0-4 连接生命周期（G1/G4/G5/G2/G6） | 11 | PASS（含 2 WARN） | stdio 每 session 独立进程；HTTP 远端共享但 mcp-session-id 全独立；单 session 关闭不影响他者 |
| M0-4B 并发调用（G3） | 3 | PASS | 2 session 并发 slow(3000) 结果不串扰、双调用到达 server |
| M0-5 exposure 行为（A/B/C） | 6 | PASS | direct 直调成功；**hidden 经 codemode `searchTools` 返回 0 结果、调用不可达**；deferred 经 tool_search 加载后调用成功 |
| M0-6 Journal 可观测范围 | 8 | PASS | 静态结论运行时钉死：journal entry 无任何工具级记录；事件流含工具载荷（M2 通道前提成立） |

---

## 二、新增实证事实（回填计划文档 F 系列）

| # | 事实 | 证据 |
|---|---|---|
| F13 | **注册层 `codemode`→`deferred` 映射**：`toolExposure` 配置 `codemode` 的工具，注册到 session 后 `ToolInfo.exposure` 呈现 `deferred`（`toToolExposure()`）。语义：codemode/deferred 在可达性层面等价（不进模型声明、经 discovery 工具可达），差异只在激活哪个发现通道（codemode→codemode 工具 / deferred→tool_search）。`hidden` 是唯一硬拒绝，`direct` 是唯一进声明 | `extensions/mcp/tools.js:25-26` + m0-2B debug 输出 |
| F14 | **server 名中 `-` 在 mcp__ 工具名中替换为 `_`**（`mcpNamespace`）：`fix-a` → `mcp__fix_a__echo`。策略层结构匹配不受影响；session 层 `excludeTools` 写 `mcp__*` 名时需用替换后形式 | `core/mcp-servers.d.ts:108-109` + m0-2A 实测 |
| F15 | **发现（WARN）：`session.dispose()` 不回收 stdio MCP server 子进程**（不杀进程、不关 stdin，fixture 的 stdin-EOF 自杀逻辑未触发）。风险：同进程内反复创建/销毁会话会积累僵尸；脚本主进程退出后管道断裂自然回收。**待验证**：prompt 后 dispose 是否不同；M2 的 PiAgentAdapter 需补偿清理（显式断开连接/杀进程）或跟进上游 | m0-4 G4/G5 WARN |
| F16 | **发现（WARN）：401 需认证 server 在 headless 会话中阻塞好 server 的工具注册**（同场 60s 好工具仍未出现；未配置 OAuth provider 时无解）。**结论：需认证/不可信 server 必须在 loadConfig 过滤层挡掉（默认拒绝原则从"最佳实践"升级为"硬前提"）** | m0-4 G6 WARN |
| F17 | **事件流工具载荷确认（M2 通道数据前提成立）**：`session.subscribe` 事件含 `tool_execution_start`（载荷 `toolCallId, toolName, args`）与 `tool_execution_end`——工具名/参数/配对 ID 均可从事件流取得；完整类型清单 10 种（agent_start/turn_start/message_start/message_end/message_update/tool_execution_start/tool_execution_end/turn_end/agent_end/agent_settled） | m0-6A + `results/m0-6a-events-sample.json` |
| F18 | **codemode 嵌套调用归因**：脚本内工具调用的 `tool_call` 事件带 `parentToolCallId`（指向 codemode 工具调用），M2 审计可区分"模型直调"与"脚本内调用" | `extensions/types.d.ts:939-940` + m0-3B 实测 |

## 三、对 M1/M2 的直接影响

1. **M1**：filterMcpConfig 的"显式开放"值用 `codemode`（配置层语义，让扩展激活 codemode 通道，符合本项目推荐的批量脚本组合）；断言口径改为注册层呈现 `deferred`（F13）。
2. **M1**：`<server>:<tool>` 规范名在策略层结构匹配不受 F14 影响；但产出给 session 层 `excludeTools` 的 `mcp__*` 字符串必须经 mcpNamespace 同样替换。
3. **M2**：PiAgentAdapter 的 dispose/cancel 路径需补偿 F15 泄漏（实测 prompt 后 dispose 行为；若同样泄漏，考虑向上游报 issue 并在 Adapter 层记录待清理连接表）。
4. **M2/运维**：F16 确认默认拒绝是硬前提；宿主 `mcp.json` 中含需认证 server 时，未显式授权的 Agent 会话不得加载（loadConfig 过滤天然解决）。
5. **M0-6 落地确认**：journal entry 字段清单（key/hash/result/model/label/workflowLabel/phase/agentType/sessionId/prompt/outputType/executionId/attempt/startedAt/durationMs/usage）——M2 新增 `toolCalls[]` 的基线即此清单加字段。

## 四、遗留问题

| 问题 | 处置 |
|---|---|
| dispose 泄漏的 prompt 后行为未测 | M2 改造时顺带复测（PiAgentAdapter 真实路径） |
| deferred 模式下模型操作 tool_search 的稳定性 | glm-5.3-flash 单次成功；M2 联调用例中持续观察 |
| codemode 脚本编写成功率依赖模型能力 | M2 联调建议默认 exposure=deferred（tool_search 加载直调更稳），codemode 模式留作批量组合场景 |
| Windows 端口保留段（EACCES）导致 HTTP fixture 随机失败 | fixture 已自动换端口重试（ready 文件回传实际端口）；本机环境注意事项 |

## 五、证据清单

全部落盘于 `dev-examples/mcp-m0-verification/lib/results/`（8 个 JSON，57 断言全 PASS）：
`m0-warmup / m0-1 / m0-2A-2B-2C / m0-3A-3B / m0-4-G1-G4-G5-G2G6 / m0-4B-G3 / m0-5A-5B-5C / m0-6A-6B`；
事件载荷样例 `m0-6a-events-sample.json`。fixture：`fixture/echo-mcp-server.mjs`（stdio）、`fixture/echo-mcp-http.mjs`（streamable HTTP）。
