# MCP-M4 执行报告：Workflow 直调 MCP（官方 code-mode 同款形态）

- 日期：2026-11-18
- 对应计划：`dev-docs/planning/2026-11-17-mcp-integration-执行计划.md` 第四节（M4 部分）
- 结论：**M4 核心交付完成**——workflow 脚本 JS 内直接调用 MCP（不经子 Agent），契约 10 断言 + 宿主真实 server e2e 6 断言全 PASS
- 需求来源：用户明确预期「workflow 里面能够直接调用 mcp 方法，和官方的 code-mode 一样的方式」——M2 的子 Agent 间接调用不满足，本报告将 M4 的直调部分提前交付

---

## 一、交付物

| 文件 | 内容 |
|---|---|
| `src/mcp/mcp-client-pool.ts` | **受控 Client 池**（Workflow Runtime 持有）：pi-mcp `McpClient` + `StdioTransport`/`StreamableHttpTransport`；配置复用 `readMcpConfigFiles`+`filterMcpConfig`（M1/M2 同一策略链）；懒连接、请求级超时（默认 60s，覆盖 pi-mcp 内部 30s 默认）、run 结束 `dispose()` 显式回收（F15 教训：stdio 子进程必须显式关闭）；`makeMcpInvoker` 组装注入对象 |
| `src/engine/runtime/workflow-runtime.ts` | root `meta.mcp` 懒建池（run 级）；globals 注入 `mcp`（`call/listTools/listServers`）与 `tools`（官方 prelude 同款：**宿主侧预生成普通函数对象**，key 为 `mcp__<server>__<tool>`）；未声明 `meta.mcp` 时注入拒绝桩（默认拒绝）；`onMcpCall` 审计回调；直调计入 `toolCount`（纯 MCP workflow 合法，P4.1 语义）；finally dispose |
| `src/engine/types/index.ts` | `WorkflowMeta.mcp?: McpPolicy`（脚本静态声明） |
| `tests/contract/mcp-direct.test.ts` | 10 断言：call/proxy 成功、listTools/listServers、默认拒绝、denyTools hidden、白名单外拒绝、审计摘要（不含参数值）、纯 MCP workflow 合法 |
| `dev-examples/sample-project-acceptance/mcp-host-servers-test/workflows/mcp-direct.workflow.js` + `m4-direct.ts` | 宿主真实 web-reader/zread 端到端验收 |

## 二、调用形态（workflow JS 内，官方 code-mode 同款）

```js
export const meta = {
  name: "my_flow",
  mcp: { enabled: true, servers: ["web-reader", "zread"], allowTools: ["web-reader:*", "zread:*"] },
}

// 形态一：显式 call（structuredContent 优先返回，对齐官方结果规则）
const page = await mcp.call("web-reader", "webReader", { url: "https://example.com" })

// 形态二：官方同款 proxy（tools.mcp__<server>__<tool>）
const repo = await tools.mcp__zread__get_repo_structure({ repo_name: "earendil-works/pi" })

// 反射
mcp.listServers()
await mcp.listTools("zread")
```

权限语义：**root `meta.mcp` 声明建池白名单（默认拒绝）；child workflow 各自声明，可达面 = root 白名单 ∩ 自身 servers**（child 不能超出 root）；工具级 allow/deny 在 root 声明，child 只收敛 server 面。未声明 `meta.mcp` 的脚本，`mcp.*`/`tools.*` 调用抛错（拒绝桩）。

## 三、验证汇总

- `npm run build`：通过
- 契约 91/91（含 mcp-direct 10 新增：call/proxy/list/默认拒绝/deny/白名单外/审计不泄参数值/纯 MCP workflow 合法）
- 引擎 206/206（零回归）
- 宿主真实 server e2e（`m4-direct.ts`）：6/6 PASS——`mcp.call` 读网页 293ms、proxy 读 zread repo 1.1s、`agentCount === 0`（**不经子 Agent**）、toolCount 计入

## 四、实现发现（对官方实现的印证与差异）

1. **node:vm 跨边界 Proxy 不可靠**：初次实现用 `tools` Proxy（get trap 动态解析），跨 context 后属性访问返回 undefined（"is not a function"）。官方 prelude 的做法是**宿主侧预生成普通函数对象注入**（`globalsJson` → 逐工具函数），guard Proxy 在 QuickJS 沙箱内部再包一层（跨边界无此问题）。我们改为同款预生成——工具集以连接后首次 `listTools` 快照为准（MCP server 工具集连接后视为稳定，与官方一致）。
2. **pi-mcp 请求级默认超时 30s**：池层 60s 超时必须传到 `McpRequestOptions.timeoutMs` 才生效（client 内部默认 30s 会先行触发）。已修（`callTool/listTools` 均传）。
3. **脚本变量遮蔽坑**：注入的 `globals.tools` 可被脚本局部 `const tools = ...` 遮蔽（验收脚本首次即踩）——文档需提示脚本作者避免用 `tools`/`mcp` 作局部变量名。
4. **`loadMcpConfig`/`getMcpToolExposure`/`mcpNamespace` 均未从 SDK 主入口导出**：池内自实现等价逻辑（exposure 判定含模式匹配首匹配语义、namespace `-`→`_`），与 M0 的 F12/F14 一致。

## 五、遗留

- 池为 run 级（每 runWorkflow 一池）——高频多 run 场景的跨 run 连接复用（连接池共享）留待后续迭代（首期优先隔离与简单）
- `mcp.call` 的结果暂不写入 journal（走 `onMcpCall` 回调 + run 日志）——独立 `McpCallRecord` journal entry 形态与副作用 Replay Policy 联动仍在 M4 后续范围
- OAuth：HTTP server 401 需认证场景不支持（F16：策略过滤层天然挡掉，直调池同样只连白名单内 server）

## 七、补记（同日）：默认语义变更为「默认开启」（用户决策）

用户明确要求「未声明 meta.mcp 时像官方一样直接可用」，已按此变更：

- **workflow 直调（M4）**：未声明 `meta.mcp` → 可达面 = 宿主 mcp.json 全部 enabled server（默认开启）；`meta.mcp.enabled: false` 才禁用（拒绝桩）；声明了则按声明收敛（servers 白名单/denyTools/exposure）。
- **实现**：`filterMcpConfig` 新增 `defaultServers` 模式参数（`"none"` 缺省 / `"all"`），池与 runtime 传 `"all"`；懒连接兜底 F16（只连实际调用的 server，阻塞面=调用面）。
- **M2 子 Agent 保持默认拒绝**（信任模型不同）：子 Agent 是模型自主探索 + bindExtensions 全连（N×M 并发连接成本 + F16 阻塞），脚本要给子 Agent MCP 必须显式 servers 白名单。两条通道语义分叉已在报告中说明。
- **`tools` 对象实现变更**：预生成枚举方案废弃（默认全量时每次 run 都枚举宿主全部 server，实测拖死引擎测试 600s+），改为**沙箱内 Proxy + 宿主同步桥**（`globalThis.tools = new Proxy(...)`，官方 prelude 挂 globalThis 的同款方式；调用时才校验可达面/连接，零枚举成本）。未知名报含可达 server 列表的策略错误。
- 脚本作者注意事项：避免用 `tools`/`mcp` 作局部变量名（遮蔽注入对象）；`tools.<未知名>` 报含可达 server 列表的错误，枚举用 `mcp.listTools(server)`。
- 测试：mcp-policy 17（新增 defaultServers "all" 3 条）、mcp-direct 11（未声明→全量可用、显式禁用、可达面文案）全绿；契约 95/引擎 206 零回归；宿主真实 server e2e 6/6。
