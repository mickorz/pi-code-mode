# 官方 Codemode 文章分析：Pi 的 MCP 调用实现

- 日期：2026-11-18
- 分析对象：Armin Ronacher（mitsuhiko）《What is Codemode》（https://lucumr.pocoo.org/2026/10/6/codemode/，2026-10-06）
- 源码对照：`thirdparties/pi`（earendil-works/pi @ 4afe78d，main，浅克隆）
- 关联计划：`dev-docs/planning/2026-11-17-mcp-integration-执行计划.md`（本期 M0-M2 已完成）

---

## 一、文章核心观点

### 1. 立场演变

作者一年前写过《Code Is All You Need》《MCP needs code》，主张不要把自定义工具/MCP server 全量塞进模型上下文，而应让模型写脚本。Pi 1.0 的 MCP 支持"经 Codemode 实现"是这一立场的落地——**但 Codemode 的意义远不止 MCP**。

### 2. Brains vs Hands（核心心智模型）

| 角色 | 是什么 | 信任级 |
|---|---|---|
| Brain（harness） | 运行 pi 的机器，模型工具调用的编排方 | 可信侧 |
| Hands（execution environment） | bash 与工具实际执行的地方（常与 brain 同机但概念分离） | 可沙箱化 |

关键推论：两者**文件系统不同、信任级别不同**。Gondolin 类沙箱能罩住 bash（hands），罩不住 harness 本身。

### 3. Codemode 的本质与沙箱规格

> Codemode 是 LLM 在 **harness 侧**（而非执行环境侧）表达和编排复杂操作的方式，运行在自己的沙箱里。

Pi 的实现规格（源码印证）：

| 维度 | 文章说法 | 源码证据 |
|---|---|---|
| 语言运行时 | "QuickJS within a WASM runtime" | `packages/codemode/src/wasm.ts`、`runtime/vm.ts`（quickjs-wasi） |
| 限制面 | "no network, no file system, no timers, limited RAM" | vm.ts:25 "deterministic…has no timers"；execute.ts:593 `memoryLimitBytes: 256MB`；worker 无任何 IO 桥 |
| 唯一出口 | "The only way is to call more tools" | prelude 只注入 `tools`/`models`/输出 helpers 的桥（`prelude-source.ts` host bridge closure） |
| 中断 | — | vm.ts:176 interruptHandler + JOBS_PER_POLL 轮询；worker.ts Atomics interrupt |

### 4. MCP 调用方式（文章第 4 节，最相关部分）

**MCP 工具完全不暴露给 LLM**（默认 `exposure: "codemode"`）。调用形态是"渐进式发现"（progressive discovery）：

1. 模型经 system prompt 的 `mcp_servers` 区段知道**有哪些 server**（不是有哪些工具）——文章：agent 调 Sentry MCP"不是瞎猜"，它从注入的系统提示得知 server 存在
2. 模型写 Codemode 脚本，脚本内先 `searchTools()` 按主题发现工具，再 `tools.mcp__sentry__find_organizations({})` 直接调用
3. 复杂编排（`Promise.allSettled` 并发 fan-out 多 org）在脚本内一次完成，**中间过程不进模型上下文**

### 5. 超越 MCP 的能力（Codemode 的真正野心）

- **models API**：`models.getAvailableOfType("image")` 生成图片、`models.classify(jev, {...})` 批量分类——这些 AI SDK 能力"做成常规工具只会浪费上下文"，经 Codemode 暴露零成本
- **store()/load()**：跨 Codemode 调用暂存 JSON 状态（写入 session transcript 的 custom entries，分支各自可见）
- **`image()`/`text()`**：把图片/文本直接扔回模型上下文 + 落盘临时工件
- **并发**：脚本内 `Promise.all` 合法，harness 侧限并发 4 + 排队
- **大输出**：常规工具调用只进尾部 2000 行；Codemode 侧结构化拿全量，超出部分溢出到文件（"read with offset/limit"）

### 6. 对 MCP 生态的四条建议（作者的批评）

1. **Structured content**：Codemode 想要 `outputSchema` 驱动的结构化 JSON 返回，很多 server 还做不到
2. **Consistent results**：server 按 token 优化动态裁剪返回（5 条探测成功、批量 100 条时字段变形）会让脚本失败
3. **Large binary data**：MCP 尚不支持大二进制，被迫用预签名 URL 绕道
4. **Composable tool search**：server 可能比 client 更懂哪个工具合适，但没有跨 server 的 fan-out 搜索机制，全靠涌现行为，不 scale

### 7. 对"两次 Codemode"的批评

Cloudflare 式"在 MCP server 内做 codemode"导致 Codemode-in-Codemode：双重 JSON 转义、小模型易混淆、内层代码调不了外层工具。

### 8. 未来方向

- **Durability**：Codemode 长脚本的持久化"可能要借鉴 durable workflow 引擎的快照思路"——与我们的 journal/replay 方向直接呼应
- **Starlark 或许比 JS 更合适**（确定性组合语言）

---

## 二、pi 源码对照（机制级）

### 1. Codemode 工具的可达面与权限管线

`packages/coding-agent/src/extensions/codemode/tool.ts` 头注释（权威表述）：

> Scripts can call the agent loop's nested tools: **active `direct` tools and every `codemode` or `deferred` tool**. Nested calls run through the agent loop's tool pipeline (`ctx.executeTool`), so **validation, `tool_call`/`tool_result` hooks, and permission checks apply exactly as for direct calls**. **Only the script's output reaches the model; nested results do not.**

三个机制与本期 M0/M2 实证完全互证：

| 官方机制 | 我们的实证 |
|---|---|
| 嵌套调用走 `ctx.executeTool` 完整管线 | M0-3：direct 与 codemode 双路径拦截均生效、调用未达 server |
| 可达面 = direct(active) + codemode/deferred 全部 | agent-session.js `_getCallableTools()`（`exposure === "codemode" || "deferred" || direct&&active`） |
| hidden 工具不可达 | M0-5B：`searchTools` 返回 0 结果 |

### 2. 嵌套结果的形态规则（tool.ts）

- 声明了 `outputSchema` 的工具 → 解析为 `structuredContent`（错误结果带 structuredContent 同样解析）
- 其他工具 → 文本内容拼为一个字符串
- 失败/被拒/非法参数 → reject with Error（携带工具错误文本）——脚本内可 catch 做批量容错（文章 Sentry 例子的 `Promise.allSettled` 依赖此语义）

### 3. store/load 的会话语义（tool.ts + prelude-source.ts:288-330）

- JSON 值跨 Codemode 调用保持；单值与总量都有字符限额，超限报错并提示 "write it to a file with a tool"
- 成功脚本的写入以 **`codemode-store` custom entries 追加到 session**——"each branch sees the values written on its own path"（会话分支树各自可见自己的写入）
- prelude 阶段冻结内建对象（脚本 patch `Array.prototype.toJSON` 无法污染宿主视图）

### 4. tools 对象与 searchTools（prelude-source.ts:240-454）

- `tools` 是 Proxy guard：访问不存在的工具名抛 TypeError 并给出 "Did you mean…" 拼写建议（`guard()`）
- `ALL_TOOLS` 全量清单、`searchTools(query, {limit, namespace?})` 经 **BM25 本地排名器**（`extensions/tool-search`：`new Bm25Ranker().rank(...)`）——无 LLM 参与
- MCP 工具以全名 `mcp__<server>__<tool>` 作为 tools 的 key（文章 `tools.mcp__sentry__find_organizations` 即此）；server 级 namespace 名 = `mcpNamespace(server)`（`-`→`_`，与我们的 F14 一致），`describeNamespace("docs")` 找 `mcp__docs`
- 重名 sanitize 冲突加 hash 后缀，先到先得不依赖列表顺序（`extensions/mcp/index.ts:398-410` createMcpToolName）

### 5. 并发与资源（execute.ts）

- `MAX_CONCURRENT_MODEL_CALLS = 4`（classify/generateImages 限并发，Promise.all 排队）——文章"limits the total number of concurrent tool executions itself to four"即此
- worker 池：`PI_CODEMODE_MAX_WORKERS` 环境变量，QuickJS 在 worker 线程跑，不阻塞 harness
- 大输出溢出：`[Full output: <path> (read with offset/limit)]`（execute.ts:466）

### 6. models API（execute.ts:112-750）

`MODEL_TYPES = {chat, image, classifier}`；`models.getAvailableOfType/getModelOfType/classify/generateImages`——AI SDK 能力的白名单桥接，带 classifier context 校验（防小模型写出错误 shape）。

---

## 三、与 pi-code-mode 实现的对照

### 1. 层级关系：我们不需要重实现，官方机制在子会话内原样成立

| | 官方 pi | pi-code-mode |
|---|---|---|
| 定位 | 单 harness：codemode 是**模型的一个工具** | **多 Agent 编排层**：agent() DSL 调度多个独立 AgentSession |
| Codemode 实现 | packages/codemode（QuickJS/WASM） | **直接装配官方 `createCodemodeExtension()`**——不自建 |
| MCP 接入 | MCP 扩展（exposure 分级 + codemode 激活） | **直接装配官方 `createMcpExtension()`** + 我们新增的 loadConfig 策略过滤 |
| MCP 调用形态 | 模型写 JS：searchTools → `tools.mcp__*` | **同一形态**：M0-1/M0-5 实证 deferred 经 tool_search、codemode 经脚本内调用均成立 |

**关键结论**：文章描述的全部调用方式，在我们 M2 装配的子 Agent 会话内**原样可用**（`createCodemodeExtension` 就在工厂列表里）。官方的 progressive discovery（system prompt 告知 server 存在 → 脚本内 searchTools → 调用）不依赖宿主 CLI，SDK 会话同样走 MCP 扩展的 `mcp_servers` system prompt 区段。

### 2. 我们的差异点：Agent 级策略层（官方没有的）

官方是单用户 harness 场景——所有 MCP server 对一个模型可用，无"每个 Agent 不同权限"问题。我们的场景是**一个 workflow 编排多个权限不同的 Agent**，因此在官方 exposure 机制之上加了：

- `filterMcpConfig` 策略层：per-Agent server 白名单 + 工具 allow/deny + 默认拒绝（deny 键序恒胜）
- 事件侧 `toolCalls` 审计 + journal 双落点（成功 entry / 失败 attempt）
- 这是**对官方模式的后置过滤扩展**，不改变官方管线语义（M0-3 已证拦截仍生效）

值得注意的呼应：官方 `exposure: "hidden"`（不可达）就是 M1 默认拒绝的落地机制；官方"精确名赢过模式、首匹配获胜"就是 M1 deny 键序的依据——我们 M1 的设计直接建立在官方语义上，文章与源码双向印证。

### 3. 我们没有的东西（由官方扩展在子会话内天然提供，无需自建）

| 官方能力 | 我们子会话内的状态 |
|---|---|
| `store()`/`load()` 跨调用状态 | ✅ 随 `createCodemodeExtension()` 自动可用（session 内） |
| `models.*`（image/classifier） | ✅ 同上（需 provider 配置了对应模型类型） |
| 大输出溢出文件 | ✅ 同上 |
| BM25 `searchTools` | ✅ 同上 |

workflow 编排层的对应物：脚本间状态传递走我们的 `args`/`return`/journal（跨 Agent 传递状态本来就是编排层的职责），与官方 store/load（同一 Agent 会话内的跨脚本状态）是不同层的互补。

### 4. 文章未来方向 vs 我们的已有能力

| 文章方向 | pi-code-mode 现状 |
|---|---|
| Durability：快照 Codemode 调用 | 我们在**编排层**已有：journal hash/replay、失败 attempt 双落点、resume 指纹（tools 计入 hash）。文章说"可能要借鉴 durable workflow 引擎"——我们恰好就是 durable workflow 引擎形态 |
| 确定性组合语言（Starlark） | 我们的 workflow DSL 是受限面（node:vm + 注入函数，无网络/FS），方向一致；Codemode 内部仍 JS（官方实现），不在我们控制面 |
| structured content 建议 | 对接/编写 MCP server 时的选型建议：优先 `outputSchema` 齐全的 server |

---

## 四、可操作结论

1. **无需架构改动**：文章描述的 MCP 调用方式（progressive discovery + 脚本内调用）在我们子 Agent 会话内由官方扩展原生提供，M0-M2 已实证。我们的差异化价值在编排层（多 Agent 权限隔离 + 审计 + 恢复），与官方互补而非重叠。
2. **M3/M4 立项时的两个参考点**：
   - Workflow 直调 MCP（M4 的 `mcp.call()`）设计时可参考文章"server 内 codemode 是坏味道"的批评——编排层直调应走 pi-mcp 的 `McpClient` 结构化返回（outputSchema/structuredContent），不要让脚本拼 JSON 字符串
   - 副作用与 durability：文章推荐 durable workflow 快照思路——我们的 journal/replay 已是同形态，M4 的副作用工具 Replay Policy 设计可直接复用该框架
3. **上游反馈项（已在台账）**：F15 dispose 泄漏、`loadMcpConfig` 未导出——`thirdparties/pi` 源码在手，可精确定位提 issue。
4. **MCP server 选型/编写建议**（文章第四节，可写入用户文档）：优先返回 structured content（outputSchema）且结果形态稳定的 server；大二进制避开 MCP 通道。

---

## 六、补充：pi-code-mode 与官方 code-mode 在「JS 中调用 MCP」上的区别（2026-11-18 补）

前提澄清：pi-code-mode 不自建 JS 调 MCP 机制——子 Agent 会话内的 Codemode 就是官方 `createCodemodeExtension()` 那份代码，脚本写法（`searchTools()` → `tools.mcp__server__tool()`）一字不差。区别在调用主体、可达面、生命周期与审计：

| 维度 | 官方 pi code-mode | pi-code-mode（M2 后） |
|---|---|---|
| 调用主体 | 同一个 harness 内的同一个模型：先写 codemode 脚本再调 MCP | 外层 **workflow JS**（node:vm，编排层，不调 MCP）发起 `agent()` → **新的子 AgentSession 里的另一个模型实例**去写 codemode JS 调 MCP；两层 JS 主体与目的不同（外层确定性编排 / 内层模型探索） |
| JS 运行环境 | QuickJS WASM 沙箱（无 IO） | 子会话内同官方（QuickJS）；外层 workflow JS 在 node:vm（受控注入，无网络/FS） |
| 可达面 | 宿主 mcp.json 全部已连接 server（单用户，无 per-agent 权限概念；仅 exposure 分级） | **被 Agent 级策略收窄**：`agent({ tools: { mcp } })` 声明白名单 → loadConfig 过滤 → codemode 的 searchTools/tools 只能见白名单内工具；同一份官方运行时，可达面由 policy 决定 |
| 连接生命周期 | MCP 连接属于长驻宿主会话（/mcp 管理，跨调用复用） | 连接属于一次性子 AgentSession（stdio 每 session 独立进程，M0-4/F15：dispose 不回收） |
| 审计 | 走工具管线（tool_call hooks），但无跨会话持久化（inMemory 会话丢弃） | 事件侧采集 → **journal toolCalls 双落点**（成功 entry / 失败 attempt），run 级可追溯 |
| 嵌套深度 | 模型 → codemode JS → MCP（单层） | workflow JS → agent() → 子模型 → codemode JS → MCP（两层，但避开了文章批评的 Codemode-in-Codemode 反模式：外层不调 MCP，无双重转义，内层可正常走管线） |
| store/load | session 内跨 codemode 调用保持 JSON 状态 | 子会话内同官方可用；跨 Agent 状态传递走编排层 return/args（不同层互补） |

一句话：官方解决「模型怎么用 JS 调 MCP」，pi-code-mode 解决「多个各有权限边界的 Agent 在一次 workflow 里被编排去调 MCP」——内层调用机制完全复用官方，外层加了策略收窄、生命周期隔离与审计。

## 五、引用

- 文章：Armin Ronacher, *What is Codemode*, https://lucumr.pocoo.org/2026/10/6/codemode/（2026-10-06）
- 源码：`thirdparties/pi`（@ 4afe78d）
  - 沙箱：`packages/codemode/src/runtime/vm.ts`、`worker.ts`、`prelude-source.ts`
  - Codemode 工具语义：`packages/coding-agent/src/extensions/codemode/tool.ts`（头注释）、`execute.ts`（并发 4、256MB heap、溢出文件、models API）
  - searchTools：`packages/coding-agent/src/extensions/tool-search/tool.ts`（BM25）
  - MCP namespace/命名：`packages/coding-agent/src/extensions/mcp/index.ts:385-430`
- 本仓库对照：`dev-docs/progress-result/MCP-M0-执行报告.md`（F9/F13/F14/F18）、`MCP-M2-执行报告.md`、`dev-docs/planning/2026-11-17-mcp-integration-执行计划.md`
