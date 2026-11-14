# Runtime 宿主依赖审计报告（M0-1）

> M0 技术验证产出物之一。审计对象：`thirdparties/opencode-dynamic-workflows`（固定 commit `7f6e93a`）。
> 目的：验证 R3 需求第 1.2 节的待验证假设——runtime 引擎对宿主语义的隐含耦合面，为 AgentAdapter 契约（`dev-docs/design/adapter-contract.md`）提供事实依据。
> 取证方式：逐文件实地核对，所有行号可查。日期：2026-11-14。

## 0. 架构总览与数据流

```
src/index.ts:29-55 插件入口（只注册 tool，无任何宿主事件钩子）
  ├─ tools/workflow.ts        workflow 工具（前台阻塞执行 + journal/resume/快照/confirm 接线）
  ├─ tools/background-runs.ts 后台 run 注册表（AbortController + 心跳 + 终态回传）
  ├─ runtime/workflow-runtime.ts  宿主无关核心（VM 脚本、journal 回放、并发、组合节点）
  │     └─ agent/session-runner.ts   唯一注入缝接口 AgentSessionRunner
  │           └─ adapters/opencode-session-adapter.ts  全仓库唯一触碰 OpenCode SDK 处
  ├─ persistence/journal.ts   journal 落盘（读-合-写、原子 rename）
  ├─ isolation/worktree.ts    git worktree 隔离
  └─ tui/*                    独立进程的 TUI 轮询读者（禁止 import server 模块）
```

对照第 2.4 审计矩阵的逐模块结论：

| 模块 | 矩阵预期 | 审计结论 |
|---|---|---|
| VM / Prelude | 优先直接复用 | 成立。VM/确定性中和/静态拦截无宿主耦合 |
| DSL 原语 | 优先直接复用 | 成立，但错误形态依赖「Adapter throw + Engine 分类」模型（见 §2） |
| Workflow Runtime | 复用 + 局部适配 | 成立。调度/并发/cancel 链宿主无关；journal key 结构需按 §1 决策处理 |
| Journal | 优先复用 | 有条件成立。结构可复用，但 key 语义是序号制（见 §1，M2 需升级） |
| Composite | 优先直接复用 | 成立。race 局部取消经 AsyncLocalStorage，宿主无关 |
| Worktree | 复用 + 环境适配 | 成立，且已带 Windows 实证经验（正斜杠强制、prompt 注入传递） |
| Schedule | 较大概率改造 | 初步成立：root session 创建点在 BackgroundRunManager，是唯一宿主创建依赖，M3 处理 |
| TUI | pi 专用重写 | 成立。跨进程文件轮询契约（AgentRecord 快照）可整体替换为 pi 事件流 |

## 1. Journal / Resume 的精确机制

**结论：key 是「运行时调用序号」（同步领号，调用顺序决定身份），不是稳定调用点身份；resume 是每 scope 的「最长未变前缀」（firstMiss 数值截断），hash 只含 prompt/model/tier/phase/agentType/schema/isolation 七项，不含脚本文件 hash。**

### 1.1 key 结构与领号

- 存储布局 `src/persistence/journal.ts:11-14`：`<项目>/.opencode-workflows/journal/<runId>.json` → `{ version:1, runId, entries: { "runId:callIndex": entry } }`
- key 组合 `src/runtime/workflow-runtime.ts:273-276`：
  - root scope：`runId:N`
  - child scope：`runId:wfK:wfM:N`（`scope.pathKeys.slice(1)` 拼接）
- **callIndex 是运行时序号**：`agentImpl` 内 `const callIndex = scope.callSeq++`（`workflow-runtime.ts:441`）。`callSeq++` 位于首个 await 之前的同步前缀，因此 parallel 数组内按数组下标顺序同步分配，与完成时序无关。
- 子工作流领号同理：`workflow()` 首行同步 `childSeq++`（`workflow-runtime.ts:703-707`，注释明言「parallel 下异步化会让 wfN 按完成顺序分配，journal 不稳定」）。child 的 `callSeq/childSeq/firstMiss` 全部 scope 私有（217-227）。
- `checkpoint()`（1352）与 `runTool()`（1003/1021）消耗同一 callSeq；组合节点 sequence/fallback/race 不占 callSeq（独立 compositeSeq，221-222），对 resume 透明。
- 推论：**同 scope 内 agent/checkpoint/runTool 共用一个序号空间**——插入/删除任何一个调用点，其后所有 key 移位，全部重跑。

### 1.2 hash 面与回放算法（回应评审「scriptHash 粒度」问题）

- `hashAgentCall`（`workflow-runtime.ts:1554-1567`）：`sha256(JSON.stringify({ prompt, model, tier, phase, agentType, schema, isolation }))`。**不含脚本文件内容 hash、label、timeoutMs、retries、args**；model/tier 只取脚本声明值，解析结果不进 hash。
- 回放判定（464-483）：
  ```ts
  hashMatches = cached?.hash === callHash
  cachedEmpty = hashMatches && isEmptyTextResult(...)   // 无 schema 且空白串
  命中条件: hashMatches && !cachedEmpty && callIndex < scope.firstMiss
  未命中: firstMiss = min(firstMiss, callIndex)         // 前缀在此截断
  ```
- **评审场景实测推演**：改第 2 个 agent 的 prompt → callIndex 0 hash 命中且在 firstMiss(=1) 之前 → 第 1 个复用；callIndex 2 位于 firstMiss 之后 → 第 3 个重跑。**前缀精确停在首个 hash 不匹配处，不存在「整文件 hash 失效导致全部重跑」的问题**——粒度是「输入指纹 + 位置前缀」，不是文件级。
- **重要更正**：R1 调研提到的 `resumeMode: "replay-completed"` 在代码中**不存在**（全 src grep 零匹配）。真实语义 = firstMiss 数值前缀 + **gap 按 scope 隔离**（child wf1 内的 gap 只截断 wf1 自己，root 与兄弟 wf2 各有独立游标继续回放）。
- runTool 的 journal entry 永不写 hash/result（938-946），resume 时永远重跑（廉价确定性操作）。
- resume 入口 `src/tools/workflow.ts:150-159`：续跑**复用旧 runId**（159），新 entry 追加进同一 journal 文件——key 对齐靠 runId 复用实现。后台路径不支持 resume（117-121，强制前台）。

### 1.3 换宿主改「稳定调用点身份」的影响面

若按 R3 第 5.1 节 Node Identity 替换序号制，需动：`scopedKey`（273-276）、`AgentRecord.id`（448，同时是 journal key/快照节点 id/TUI 去重键）、领号纪律（441/703/1003/1021/1352）、`firstMiss` 前缀语义（225-226/468/482/1396）、journal append 合并（`journal.ts:44-50`）、key 解析假设（`background-runs.ts:226`、`workflow.ts:190`）、resume 复用旧 runId 行为（159）。

**语义差异必须明确**：稳定身份 + 逐节点独立判定后，「中间变更不再强制其后全部重跑」——这与 opencode 前缀语义不同。决策见契约文档 §3（M1 前缀基线 + M2 升级，保守依赖校验保证线性链语义等价）。

## 2. Runtime 消费 AgentExecutionResult

**结论：唯一消费点在 agentImpl，`execution.value` 原样返回给脚本；错误一律 throw（无 result.status 通道），取消也是 throw 后靠 `isAborted()` 二次归类。**

- 接口 `src/agent/session-runner.ts:46-49`，结果形状 31-34：`{type:"text"|"structured", value, sessionId}`。
- 消费点 `workflow-runtime.ts:581-593`：`execution.value` 原样透传（584），`execution.type` 仅作展示分类（592），`return value`（666）直接给脚本。
- 错误形态：adapter 抛普通 `Error`（`opencode-session-adapter.ts:284-290`）；runtime `wrapError`（`errors.ts:29-37`）分类：abort → `WORKFLOW_ABORTED (recoverable)`；**其余未知错误一律 AGENT_FAILED 且 recoverable=true**（可重试、parallel 塌缩 null）。
- 可恢复失败重试耗尽后 **return null**（654-655）并登记 phaseFailed 闸门。
- **移植含义**：pi 版 AgentResult.status 非 ok 时，Adapter 层必须转成 throw（或 Engine 消费处转换），保持「脚本侧只见值或异常」的语义；「未知错误=可恢复」的默认会放大宿主错误分类责任，契约中要求 Adapter 对已知错误给明确 kind，未知标 `unknown`。

## 3. Usage / Token 统计

**结论：adapter 层对 step-finish parts 求和（补偿上游 info.tokens 被覆盖），runtime 层只做展示性累加，无 tokenBudget/配额依赖。**

- 求和 `opencode-session-adapter.ts:294-323`：≥2 个 step 时对 input/output/reasoning 求和（上游 processor 把 info.tokens 覆盖为最后一步）；单 step 用 `info.tokens ?? stepTokens[0]`；cost 只取顶层单值。
- 消费字段 `AgentUsage`（`types/index.ts:6-12`）：input/output/total/cost；runtime per-attempt 差值进 journal（537-541）。
- **pi 版可砍**：无任何配额决策依赖 usage；pi 消息结构不同，Adapter 按契约「拿不到就不填，禁止 0 冒充」实现即可。

## 4. 取消传播链

**结论：四级信号级联；race 用 AsyncLocalStorage 注入局部 signal；宿主会话关闭无任何清理路径。**

- 链路：tool context.abort（`workflow.ts:236-238`）→ run AbortController → 每 attempt AbortController（547-553）→ adapter 内 `client.session.abort`（141-151，fire-and-forget）。
- `isAborted()`（368-371）三源合并：run signal + composite scope signal（ALS）+ shared 标志；`throwIfAborted` 抛 `WORKFLOW_ABORTED (recoverable)`。
- race：局部 AbortController（1177）经 `compositeScopeStorage.run`（ALS，1122-1124）注入，胜出 `controller.abort()`（1206-1213）只杀兄弟候选在途 agent；settled 标志吞掉兄弟迟到失败（1190-1195/1232-1236）。
- **宿主会话关闭零清理**：`src/index.ts` 只注册 tools，无 session 生命周期钩子；后台 run 是插件进程内存 Map，主会话结束后继续跑（回传失败静默 289-294）；进程死亡则 run 消失、**在途 worktree 与 wf/* 分支泄漏（无启动清扫）**。
- **pi 版需要**：(a) 工具执行级 abort 源（pi 工具 signal）；(b) ALS 或等价 per-race 局部信号（Engine 自带）；(c) 自行决策会话关闭时孤儿 run 策略（M3 决策点，M0 只记录 opencode 版选择「不 kill」）。

## 5. 事件 / 进度

**结论：onAgentUpdate 是整条 AgentRecord 全量推送（无增量 diff），server 侧原子写快照文件（3s 心跳），TUI 进程 1s 轮询目录——纯文件轮询，pi 版可直接换事件流。**

- 发射时机（runtime）：running 创建（455-458）、回放命中（469-478）、attempt>1、onSessionCreated（576-579）、成功/aborted/failed 终态。
- 载荷 = 完整 `AgentRecord`（`types/index.ts:64-107`：id/label/phase/status/durationMs/tokens/cost/replayed/sessionId/executionId/attempt/outputPreview/compositePath 等）。回放节点无 sessionId/startedAt（空值语义 74-84）。
- 快照契约 `run-snapshot.ts:22-48`：VERSION=2、HEARTBEAT_MS=3000、STALE_MS=8000、原子写 + Windows unlink 重试；仅 running 态写心跳防覆写终态。
- **pi 版映射**：以 `AgentRecord[]` + 计数字段为最小事件载荷即可，跨进程文件轮询整体替换为 `pi.events` / widget。

## 6. checkpoint() 人工确认

**结论：confirm 回调由 tool 层注入（宿主 ask 原语映射 true/false）；确认与拒绝都写 journal，resume 时确定性重现（连「拒绝」也重放不重新弹窗）；Reject 抛 CHECKPOINT_REJECTED（recoverable:false，不可被 fallback/race 吸收）。**

- 注入链 `workflow.ts:194-205`：`context.ask({ permission: "workflow-checkpoint:<runId>:<seq>", ... })`——逐实例唯一 permission 串防宿主「Always allow」记忆吞掉后续 checkpoint。
- runtime `workflow-runtime.ts:1349-1433`：hash=`{promptText, default, headless}`；**`cached.result === false` 时重放拒绝**（1383-1389）；无 confirm 通道时 headless 走 `default ?? true` 或 `headless:"abort"` 抛出。
- Reject 顺序（1424-1433）：**先**写 journal 拒绝事实，**再** throw。
- **pi 版要求**：宿主必须有 ask/permission 原语，且「拒绝也持久化」——丢掉这点 resume 语义就变了（重新弹窗 vs 确定性终止）。M0 第 3 步需实证 pi 的对应通道。

## 7. worktree 隔离

**结论：纯本地 git 命令（rev-parse → worktree add -b → remove --force + branch -D），目录经 prompt 文本注入传给 agent（宿主 directory 路由实测无效），attempt 循环 finally 一律拆除，结果不合并。**

- 命令序列 `src/isolation/worktree.ts:66-91`：rev-parse 失败静默降级共享目录；branch=`wf/<slug>`（slug 清洗 40 字符）；路径 `<repoRoot>/.opencode-workflows/worktrees/<slug>` **强制正斜杠**（78-79，Windows 反斜杠实证导致路由失败）；`worktree add -b <branch> <path> HEAD`。
- 传递方式 `workflow-runtime.ts:507-512`：`query: { directory }` 保留但**实测无效**，实际靠 prompt 后缀注入绝对路径；journal 存原始 prompt（596-597）。
- 命名确定性：`${runId}-${callIndex}-${label}`（503）——依赖 callIndex 序号，第 1 项的 key 改动会连带。
- 拆除：agentImpl 外层 finally 一律 `removeWorktree`（659）；实现必须**从主仓库根执行**（94-101 注释），best-effort 不抛。
- Windows 风险点：宿主目录路由失效（pi 版同样用 prompt 注入规避）、win32 路径 toLowerCase 自环检查（675-676）、进程死亡 worktree/分支泄漏无清扫。

## 8. 三个意外发现（移植决策输入）

1. **`resumeMode replay-completed` 不存在**——真实机制是 per-scope firstMiss 数值截断 + scope 间隔离；后台 run 不支持 resume；resume 靠复用旧 runId 对齐 key。
2. **未知错误默认 recoverable=true**（`errors.ts:37`）——宿主错误分类错误会静默转化为重试/塌缩 null；pi 版 Adapter 必须给出明确错误 kind 映射表。
3. **宿主会话关闭零清理**——后台 run 与 worktree 生命周期完全绑定插件进程存活期；pi 版需自行决策孤儿 run 策略（M3）。

## 9. 审计初步结论

- **Go 倾向**：VM/DSL/Composite/Worktree 四模块确认可直接复用；Journal 结构可复用但 key 语义需按契约 §3 分阶段处理；Schedule/TUI 维持改造/重写预期。
- 隐含耦合面共 5 类，全部可收敛进 AgentAdapter 契约：结果透传语义（§2）、usage 可选化（§3）、取消四级链（§4）、事件全量推送（§5）、checkpoint ask 通道 + 拒绝持久化（§6）。
- **待实证项**（M0 第 3-5 步，Go/No-Go 以其结果为准）：pi 子会话 execute/cancel/timeout、工具权限与递归防护（不能只信 excludeTools，见需求 4.1）、Mock Adapter 契约测试、checkpoint 的 pi 等价通道是否存在。
