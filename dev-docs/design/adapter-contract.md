# AgentAdapter 契约（M0-2 定稿）

> M0 技术验证产出物之二。本文件是 Workflow Engine（宿主无关层）与 Pi Session Adapter 之间的正式接口契约，Engine **禁止**绕过本契约 import pi SDK。
> 依据：需求文档 R3 第 2.3 节骨架 + M0-1 审计报告（`dev-docs/research/runtime-host-dependency-audit.md`）实证结论。契约版本：1.0（M0 第 3-5 步实证通过后定稿，见 progress-result/M0-执行报告.md）。

## 1. ID 体系：executionId 与节点身份严格分离（回应评审建议 1）

两套 ID 服务不同目的，**禁止混用**：

| ID | 生成者 | 生命周期 | 用途 | 存储 |
|---|---|---|---|---|
| `executionId` | Engine，每次 dispatch 前 uuid | 单次执行 | 取消路由（`cancel(executionId)`）、日志关联、快照在途标记、attempt 差值统计 | 不进 journal key；AgentRecord 携带 |
| 节点身份（journal key） | Engine，按身份规则 | 跨执行（resume 时定位旧结果） | journal 回放、Replay Fingerprint 判定 | journal entries key |

混用后果：executionId 每次 dispatch 都变，若进 journal key 则 resume 永远找不到旧节点；反之节点身份复用会让 `cancel` 误伤同节点的历史/并行实例。

**节点身份分阶段实现**（决策依据见审计 §1）：

- **M1 基线**：沿用 opencode 序号制——`runId:[wfK:...:]callIndex`，同步领号（首个 await 前 `callSeq++`/`childSeq++`），同 scope 内 agent/checkpoint/runTool 共用序号空间，组合节点（sequence/fallback/race）不占号。resume = 每 scope `firstMiss` 前缀截断 + hash 七字段（prompt/model/tier/phase/agentType/schema/isolation）。**此语义与 sample-project 的 resume 断言（resume-test/mutate/seq_resume）逐位一致。**
- **M2 升级**：引入 R3 第 5.1 节 Node Identity（`workflowPath/scopePath/nodeKey/occurrenceKey`）替代纯序号，实现 Replay Policy 三条件。**保守规则**：上游节点任一重跑 → 其下游一律视为依赖失效、重跑（在线性链上与 opencode 前缀语义**严格等价**）；仅 parallel 中互不依赖的兄弟分支，允许在各自指纹匹配时独立复用——这是相对 opencode 的增强，不破坏 sample-project 断言。
- `scriptHash`（评审建议 2）：**不引入整文件 hash**。审计证实 opencode 版 hash 面只有七输入字段，粒度问题不存在；M2 稳定身份 + 依赖校验已覆盖「改一处 prompt 的影响范围」语义。`runtimeVersion` 进指纹由 Engine 注入，不依赖脚本内容。

## 2. 接口定义

```typescript
// ============ 契约层（Engine 依赖，Adapter 实现） ============

interface AgentAdapter {
  /** 执行一次子代理调用：创建会话、注入 prompt、等待终态 */
  execute(request: AgentRequest, ctx: ExecutionContext): Promise<AgentResult>;
  /** 按 executionId 取消在途执行（幂等；未知 id 静默成功） */
  cancel(executionId: string): Promise<void>;
}

interface ExecutionContext {
  /** Engine 生成的全局唯一执行标识（uuid），取消路由与日志关联的唯一键 */
  executionId: string;
  /** 所属 run */
  runId: string;
  /** 当前 phase 标题（journal 展示用） */
  phase?: string;
  /** 流式/进度事件通道；Adapter 全量推送 AgentRecord 形态事件，不做增量 diff */
  onEvent?: (event: AgentEvent) => void;
}

interface AgentRequest {
  prompt: string;
  /** provider/modelId 或 tier 解析后的最终模型串 */
  model?: string;
  /** worktree 隔离时为 worktree 绝对路径；Adapter 不依赖宿主目录路由，
   *  隔离语义由 Engine 以 prompt 注入保证（opencode 版实证：目录路由不可靠） */
  cwd?: string;
  tools?: ToolPolicy;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** JSON Schema；P0/M1 仅做基础结构化透传，修复循环属 M2 */
  outputSchema?: object;
}

interface AgentResult {
  status: "ok" | "error" | "cancelled" | "timeout";
  output: { type: "text" | "structured"; value: unknown };
  /** 任何非 ok 终态都允许缺省；缺省即「未知」，消费方禁止按 0 参与统计 */
  usage?: { inputTokens: number; outputTokens: number };
  sessionId: string;
  error?: { kind: ErrorKind; message: string };
}

type ErrorKind =
  | "aborted"      // 取消（run/scope/attempt 任一级 signal）
  | "timeout"      // attempt 超时
  | "model"        // 模型/Provider 拒绝（限流、余额、内容策略）
  | "session"      // 会话创建/生命周期失败
  | "schema"       // 结构化输出校验失败（重试后仍不达标）
  | "unknown";     // 未归类

type ToolPolicy = {
  /** 禁用的工具名清单（含 workflow 系工具，防递归；实测确认，见审计 §9） */
  excludeTools?: string[];
  /** 是否禁用宿主扩展加载（默认 true，防递归编排） */
  noExtensions?: boolean;
  /** 允许的工具白名单（实测 pi 支持度后再定稿，M0 第 4 步） */
  allowTools?: string[];
};

type AgentEvent =
  | { type: "session-created"; executionId: string; sessionId: string }
  | { type: "attempt"; executionId: string; attempt: number }
  | { type: "record"; executionId: string; record: AgentRecord };  // 终态全量记录
```

## 3. 语义规则（Adapter 必须遵守）

### 3.1 结果与错误

| 事项 | 规则 | 来源（审计 §） |
|---|---|---|
| 结果透传 | `output.value` 原样透传给脚本，text 不拼接、structured 不二次解析；`output.type` 仅展示 | §2 |
| 错误表达 | **Adapter 不抛异常，一律返回 `AgentResult`**；Engine 消费处把非 ok status 转为 throw（保持「脚本侧只见值或异常」语义，与 opencode 一致） | §2 |
| unknown 默认 | Engine 侧 `unknown` 按 recoverable 处理（可重试、parallel 塌缩 null）——沿用 opencode 默认；Adapter 应尽量给出精确 kind 减少误重试 | §2/§8.2 |
| usage 缺失 | 非 ok 终态允许缺省；ok 但宿主未回传也缺省；**任何层级禁止填 0 冒充已知**；Engine 展示层对缺省显示「未知」 | §3 |
| usage 求和 | pi 消息结构如存在多 step 覆盖问题，Adapter 内求和补偿，Engine 无感知（对齐 opencode step-finish 求和模式） | §3 |

### 3.2 取消与超时

- 取消链四级：tool/workflow_control cancel → run AbortController → attempt AbortController（含 race ALS 局部 signal）→ `Adapter.execute` 的 `request.signal` / `Adapter.cancel(executionId)`。前三级是 Engine 职责，最后一级是 Adapter 职责（pi 子会话 abort）。
- `cancelled` 与 `timeout` 是独立 status，**不得**归并为 error；Engine 依据 status + `aborted` 标志二次归类（对齐 opencode `isAborted()` 行为）。
- race 兄弟取消：Engine 在 race 胜出时对兄弟的 execute 发 cancel + abort signal；被取消兄弟的迟到失败由 Engine settled 标志吞掉（ALS scope 机制随 runtime 移植，Adapter 无感知）。
- 超时：Engine 统一计时（`timeoutMs`），触发时先 abort attempt controller 再等 Adapter 返回 `timeout`（或视为超时收尾）。

### 3.3 事件

- Adapter 以 AgentEvent 推送；`record` 事件载荷为终态全量 AgentRecord（形态对齐 opencode `types/index.ts:64-107`，含空值语义：回放/未创建会话时 sessionId/startedAt 可空）。
- 事件是进度通道，**不得**作为结果通道——终态以 `execute` 的 resolve 值为准。

### 3.4 checkpoint 通道（Adapter 之外的宿主要求）

- runtime 的 `checkpoint()` 需要宿主提供 ask/permission 原语；**拒绝结果也必须持久化进 journal**（resume 确定性重放拒绝，不重新弹窗）——这是语义红线，M0 第 3 步实证 pi 等价通道；若 pi 无对应原语，M2 checkpoint 降级为 headless 默认值并在执行报告记录。

### 3.5 worktree 与目录

- Adapter 的 `cwd` 仅用于子会话工作目录设置；**隔离可达性由 Engine 的 prompt 注入保证**（绝对路径 + 正斜杠），不依赖 pi 目录路由。
- worktree 创建/拆除是 Engine（isolation 模块）职责，git 命令序列沿用 opencode（`wf/<slug>`、finally 强制拆除、主仓库根执行）。

## 4. Adapter 实现职责清单（Pi Session Adapter）

| 职责 | 对应 pi SDK 面 | 状态 |
|---|---|---|
| 子会话创建（内存态、继承 provider/model 认证） | `createAgentSession` + `SettingsManager.create(cwd, agentDir)` | M0 第 3 步实证 |
| 工具装配与禁用 | `createCodingTools(cwd)` + `excludeTools` + `noExtensions`；**递归防护需实测**（第 4 步） | 待实证 |
| 结构化输出 | schema → typebox 校验；P0 透传，修复循环 M2 | 待实证 |
| usage 提取 | pi 消息结构取 token；取不到缺省 | 待实证 |
| cancel 落地 | pi 子会话 abort 等价物 | 待实证 |
| 事件映射 | AgentSession 事件 → AgentEvent | 待实证 |
| 模型解析 | tier → provider/modelId（P1/M4 tier 体系；P0 直接 model 串） | P0 用直传 |

## 5. 待实证清单（M0 第 3-5 步，Go/No-Go 输入）——已全部实证通过（2026-11-14）

> 实证结果见 dev-docs/progress-result/M0-执行报告.md；原始输出 dev-examples/m0-spike/（spike.ts 7 用例 + contract.test.ts 7 断言全 PASS）。

1. execute：pi 子会话创建 + prompt + 终态收集（文本/结构化各一例）
2. cancel：在途调用取消的传播与终态形态（cancelled status 而非 throw）
3. timeout：attempt 超时后子会话的清理
4. usage：pi 消息结构中 token 字段实际位置，多 step 是否覆盖
5. 工具禁用：excludeTools 实际生效面 + 宿主权限继承 + workflow 系工具递归禁用的可靠性
6. checkpoint：pi 是否有 ask/permission 等价原语
7. 事件：AgentSession 可观测事件清单 → AgentEvent 映射完整性
8. Mock Adapter：契约测试（status/usage 缺省/cancel/timeout 全形态）跑通

每项实测结果与预期不符时，**优先调整 Adapter，不迁就宿主改 Engine 语义**（评审结论）；确需改契约的，在本文件变更记录登记并同步需求文档。
