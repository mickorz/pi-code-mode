# pi-dynamic-workflows 斜杠命令直跑 workflow 功能接入分析

> 调研对象：`thirdparties/pi-dynamic-workflows`（REF-002，commit 3f0d7e1）
> 调研日期：2026-11-20
> 结论：**可以接入，且当前项目基础条件比第三方更好**。核心改动约 1 个新文件（~100 行）+ 主入口一行装配，执行链零新增。

---

## 一、第三方功能机制拆解

第三方体验：workflow 脚本保存后，直接输入 `/<workflow名>` 就能跑，不需要 `/workflows run <名>`。实现分四层：

### 1. 存储（workflow-saved.ts，392 行）

- `/workflows save <name> [runId]` 把某个 run 的脚本存为 JSON（name 即命令名），三级目录：project > legacy > user，同名按优先级遮蔽。
- 名字即文件名即斜杠命令名，统一校验 `isSafeSavedWorkflowName`：非空、<=128、无空白/路径分隔符/控制字符、非 `.`/`..`。
- 保存是「保留旧版 .bak」的原子写，防同名覆盖丢脚本。

### 2. 注册（saved-commands.ts，142 行）

- session_start 时 `registerAllSavedWorkflows()` 遍历 `storage.list()`，对每个 workflow 调 `pi.registerCommand(name, handler)`，一个保存的 workflow = 一个顶层斜杠命令。
- **调用时求值**（关键设计）：handler 每次触发都实时 `loadWorkflow()` 重新读存储。因为 **pi 无法注销/替换已注册命令**（loader.js 里 `extension.commands.set()` 是 Map 语义，注册后不可撤），改名/删除后旧命令仍留在补全里——调用时求值保证旧命令不再执行冻结的旧脚本，而是提示「reload 后失效」。

### 3. 冲突防护（command-registry.ts，104 行）

- `PI_RESERVED_COMMAND_NAMES` 硬编码 27 个宿主内置命令名（settings/model/new/quit/...），保留名一律拒绝注册。
- `savedWorkflowCommandAvailability()`：保留名拒绝、他方扩展已占用拒绝、自身已注册幂等跳过。
- 用 `Symbol.for()` 在 pi 对象上挂 owner map（builtin/saved），跨 reload 追踪「这个命令是谁的」。
- *注：这套硬编码是历史兼容。当前宿主已直接导出 `BUILTIN_SLASH_COMMANDS`（dist/core/slash-commands.js，26 个名字），import 即可，无需硬编码。*

### 4. 执行（saved-commands.ts handler + workflow-commands.ts）

- 有 WorkflowManager 时 `startInBackground(script, args)`：后台跑、立返 runId、进度走面板、结果经 delivery 回传会话——命令本身不阻塞会话。
- 参数解析 `parseCommandArgs`：`k=v` 形式 + 位置参数归入 `_`/`_raw` + parameters schema 默认值回填。

### 已知限制（第三方用代码换来的教训）

1. pi 不能注销命令：unregister/改名后旧命令残留到重启，靠调用时提示兜底。
2. 与宿主内置命令重名时，TUI 补全跳过该命令（interactive-mode.js 的 `getBuiltInCommandConflictDiagnostics` 打 warning），只能用完整 invocationName（如 `/name@ext`）调——所以注册前预检是必须的。
3. 同扩展内重复 `registerCommand` 同名会静默覆盖，无宿主报错。

## 二、当前项目现状对照

| 能力 | 第三方 | 当前项目 pi-code-mode | 差距 |
|---|---|---|---|
| workflow 持久注册 | 三级目录 JSON（内联脚本） | `.pi/workflows/register.json` manifest（file 引用，不复制） | 无（形态等价，我们更显式） |
| 按名执行 | `/<name>` | `/workflows run <注册表名> [k=v...]`（makeWorkflowTool 支持 scriptPath=注册表名） | 只差命令形态 |
| 后台执行 + 结果回传 | startInBackground + delivery | tool.execute(..., background:true) + deps.deliver | 无 |
| k=v 参数解析 | parseCommandArgs + schema 默认值 | parseWorkflowsRunArgs（无 schema 默认值） | 无（schema 默认值是 YAGNI） |
| session_start 钩子 | 注册 saved commands | 已有 3 处 session_start | 无，直接加 |
| 顶层命令占位 | — | workflows / schedule / explorer（须避让） | 需要冲突清单 |
| 宿主保留名 | 硬编码 27 个 | 宿主已导出 `BUILTIN_SLASH_COMMANDS` | 我们条件更好 |

## 三、接入方案

新增 `extensions/commands/workflows/direct-commands.ts`（遵循 extensions 命令规范：逻辑在 commands/，主入口只装配）：

```
registerWorkflowDirectCommands(pi, deps):
  遍历 loadRegistry(cwd)
  对每个条目 id：
    1. 安全名校验（非空、无空白/路径分隔符，参考第三方 isSafeSavedWorkflowName 的正则收紧版）
    2. 冲突预检：BUILTIN_SLASH_COMMANDS（宿主导出）
       + pi.getCommands()（他扩展）
       + 本扩展固定命令 { workflows, schedule, explorer }
       冲突则 ui.notify warning 跳过该条目，不中断其余注册
    3. pi.registerCommand(id, {
         description: `workflow: ${description}（等价 /workflows run ${id}）`,
         handler: 调用时实时 loadRegistry 确认仍存在
                  → makeWorkflowTool({ scriptPath: id, args: parseWorkflowsRunArgs(argv), background: true })
       })
```

改动点：

1. `extensions/commands/workflows/direct-commands.ts` — 新文件，上述逻辑
2. `extensions/pi-code-mode.ts` — session_start 里一行接入（cwd 用 ctx.cwd，与现有 hook 同位置）
3. `extensions/commands/workflows/register.ts` — 注册成功提示补一句「重启会话后可用 /<id> 直跑」（注册发生在 session_start，运行中 register 的条目本会话不会成为顶层命令，与第三方一致）
4. `tests/contract/commands-structure.test.ts` — 架构守卫要求新文件被主入口装配，需补用例
5. 可选：顶层命令的 `getArgumentCompletions` 挂 k=v 补全（复用 completions.ts）

## 四、风险与对策

| 风险 | 对策 |
|---|---|
| pi 不能注销命令，unregister 后 `/<id>` 残留到重启 | handler 调用时实时查注册表（第三方同款「调用时求值」），不存在则提示已注销 |
| workflowId 撞宿主内置/他扩展命令 | 注册前预检，冲突条目 warning 跳过；`/workflows run <id>` 永远可用，不损失功能 |
| workflowId 命名不规范（含空格等）导致注册异常 | register 时就做安全名校验（顺带修 register.ts 的校验缺口） |
| 注册表条目多导致补全列表膨胀 | 不做限制——manifest 是显式注册，量级由用户自控（YAGNI） |
| /reload 后重复注册 | pi 的 Map.set 语义下同扩展同名是幂等覆盖，handler 无状态转发，重复注册无害 |

## 五、工作量与验收

- 工作量：约 0.5 天（新文件 ~100 行 + 装配 + register 提示文案 + contract 测试）。
- 验收：干净房间 `pi -ne -e $REPO`，`/workflows register dev-examples/.../smoke-test.js` 后重启会话，确认 `/smoke_test` 出现在补全并可后台执行、结果回传；`/workflows unregister smoke_test` 后旧命令调用给出「已注销」提示。
- 依赖决策：无模型调用，不涉及 model-tiers 档位确认。

## 六、参考

- thirdparties/pi-dynamic-workflows：src/saved-commands.ts（注册核心）、src/workflow-saved.ts（存储）、src/command-registry.ts（冲突防护）、src/workflow-commands.ts（/workflows save）、src/pi-extension.ts（session_start 装配时机）
- 宿主：pi-coding-agent dist/core/slash-commands.js（BUILTIN_SLASH_COMMANDS 导出）、dist/core/extensions/loader.js（registerCommand Map.set 语义）、dist/modes/interactive/interactive-mode.js（重名命令补全跳过诊断）
- 本仓库：extensions/commands/workflows/register.ts、run.ts、src/engine/runtime/workflow-registry.ts、src/tools/workflow-tools.ts
