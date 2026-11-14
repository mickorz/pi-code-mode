# sample-project 验收脚本集（分类）

> 来源：`thirdparties/opencode-dynamic-workflows/examples/sample-project/scripts/`（submodule 固定 commit `7f6e93a`，只读）。
> 本目录是验收用脚本的**分类副本**，按需求文档 R3 第 3 章 8 类资产分类归位；验收执行方式见下方「跑法」。
> 分类与阶段映射以 `dev-docs/design/pi-code-mode插件需求文档.md` 第 3.2 节为准。

## 分类与阶段映射

| 目录 | 类别（脚本数） | 依赖能力 | 验收阶段 |
|---|---|---|---|
| `A-basic/` | A 基础编排（8 + adapted 3） | agent/parallel/phase/log、顺序链、嵌套链、并发限制 | M1（P0-A） |
| `A-basic/adapted/` | chain 系 pi 适配版（3） | `workflow()` 原语嵌套（替代 opencode 子代理调工具模式） | M1（P0-A） |
| `B-subworkflows/native/` | B 子工作流（16） | `workflow()` 嵌套、深度限制、自环拒绝、错误传播、resume 跨 scope | P0-B（M1）+ M2（resume 变体） |
| `B-subworkflows/composite/` | B 组合原语（13） | sequence/fallback/race、失败门、队列计时 | M1（sequence 系）+ M2（race/fallback 系） |
| `C-quality/` | C 质量与结构化（2） | judgePanel/verify/checkpoint、schema 结构化输出 | M2 |
| `D-resume/` | D 持久化恢复（1） | journal、`resumeFromRunId`、Replay Policy | M2 |
| `E-isolation-background/` | E 隔离与后台（2） | worktree 隔离、background、结果回传 | M3 |
| `F-schedule/` | F 定时调度（1） | 注册表按名寻址、schedule_* 工具族 | M4 |
| `G-ui/` | G UI 观测（14） | pi-tui widget、节点详情、checkpoint 确认 | M4 |
| `H-tiers/` | H 模型分层（1） | tier 映射与回退 | M4 |

> 原仓库 `benchmarks/`（fff 搜索基准 + ps1）依赖 opencode 专用命令，不纳入验收，未复制。

## 与原版的行为差异（pi 版适配点）

1. **chain 系**：原版经 general 子代理调用 workflow 工具实现嵌套（opencode 宿主工具链模式）。pi 版子会话按契约不加载工具（防递归编排），嵌套统一走 `workflow()` 原语——`adapted/` 三文件为等价改写，验证点（三层嵌套、prev 传递、并行 leaf）不变；leaf 由"读 docs"改为纯生成（文件读取能力由 multi-tree/acceptance 覆盖）。
2. **multi-tree-a/b**：原注释建议 background 启动（后台多树同显是 TUI 观测点，属 G 类）。M1 验收以前台方式跑脚本本身的编排语义；后台行为在 M3 用 `background-test.js` 验证。
3. **quality-dsl-test.js**：`checkpoint()` 依赖宿主 ask 原语（M0 实证 pi SDK 无对应通道，M2 自定义），M2 验收时按 headless 默认值或自定义通道跑。
4. **journal 落盘目录**：opencode 版写 `.opencode-workflows/journal/`，pi 版写 `.pi/workflows/journal/`（需求 R3 §2.2 目录约定）。

## 跑法

逐脚本执行（真实模型）：

```bash
npx tsx dev-examples/sample-project-acceptance/run-acceptance.ts <目录或脚本名>...
```

验收 runner（`run-acceptance.ts`）职责：读取脚本 → `runWorkflow`（PiAgentAdapter 真实模型）→ 按脚本类型断言 → 输出验收表。**注意**：脚本内 `agent()` 读 `docs/*.mdx` 等相对路径，runner 以 sample-project 为 cwd 执行（chain 适配版除外，自包含）。

不做的事：不修改 submodule 内任何文件（只读约定见 `thirdparties/REFERENCES.md`）。
