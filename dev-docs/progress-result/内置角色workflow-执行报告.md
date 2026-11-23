# 内置角色 Workflow 执行报告

- 日期：2026-11-20
- 计划：[2026-11-20-内置质量闭环workflow执行计划](../planning/completed/2026-11-20-内置质量闭环workflow执行计划.md)（已完成归档）
- 前置分析：[ak-pi-workflow-roles Agent 体系封装分析](../research/2026-11-20-ak-pi-workflow-roles-agent-analysis.md)
- 参考项目：`thirdparties/ak-pi-workflow-roles`（Apache-2.0，`fbe6c7c1`），仅取“职责隔离 + 组合归调用方”方法论，未复制任何 Soul 文本或代码

## 1. 交付清单

| 文件 | 内容 |
| --- | --- |
| `workflows/roles/coder.js` | 实施角色：改代码、构建与测试、如实报告；缺省 `tier=fast` |
| `workflows/roles/reviewer.js` | 评审角色：只读独立评审，findings 带 location/evidence；缺省 `tier=big` |
| `workflows/roles/judge.js` | 裁决角色：`converged / continue / escalate` 三态；缺省 `tier=big` |
| `workflows/roles/fixer.js` | 修复角色：只处理已确认 findings，缺 findings 直接报错；缺省 `tier=fast` |
| `workflows/flows/quality-loop.js` | 组合编排（零 agent）：coder → reviewer → judge →（continue 时）fixer → 复审 → 复裁；修复轮数默认 1、可传 2 |
| `tests/engine/builtin-roles.test.ts` | 12 条断言：解析/唯一性、单角色调用与档位、缺参报错、四条质量闭环路径、按角色档位覆盖 |
| `src/engine/runtime/workflow-registry.ts` | 新增内置来源：包根 `workflows/<分类>/*.js` 递归自动并入注册表（`builtin: true`），内置 id 禁止项目来源遮蔽 |
| `.pi/workflows/register.json` | 已移除五个内置条目（内置不再需要注册） |
| `.pi/workflows/reports/builtin-roles-analyze.md` | 静态分析报告 |

## 2. 契约

四个角色统一返回：

```ts
{ role 语义由 meta.id 标识, status, summary, findings[], evidence[], nextStep }
```

| 角色 | 合法 status | 是否写代码 |
| --- | --- | --- |
| coder | `completed` / `escalate` | 是 |
| reviewer | `completed` / `escalate` | 否 |
| judge | `converged` / `continue` / `escalate` | 否 |
| fixer | `completed` / `escalate` | 是 |

- 结构化输出由 `schema` 声明，宿主 adapter 侧做 typebox 校验 + 修复循环；运行时不做文本猜测。
- 所有角色明确禁止 commit / push / merge / 发版与修改全局配置。
- `quality-loop` 通过注册名调用子角色（`workflow("coder", ...)`），不内联复制角色 prompt。

## 3. 档位决策（用户确认）

| 角色 | 缺省档位 | 覆盖方式 |
| --- | --- | --- |
| coder | `fast` | `args.tier` |
| reviewer | `big` | `args.tier` |
| judge | `big` | `args.tier` |
| fixer | `fast` | `args.tier` |
| quality-loop | 按角色缺省 | `coderTier` / `reviewerTier` / `judgeTier` / `fixerTier` |

已回填 `CLAUDE.md` 的「已确认的档位决策」表。

## 4. 验收证据

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 语法自检 | `node skills/workflow-authoring/scripts/wf-syntax-check.cjs workflows/*.js` | 5/5 通过 |
| 类型与构建 | `npm run build` | 通过 |
| 引擎测试 | `npm run test:engine` | 218/218 通过（新增 12） |
| 合同测试 | `npm run test:contract` | 231/231 通过（一次 `adapter-contract` 计时用例在满载下抖动，单独复跑与二次全跑均通过） |
| 静态分析 | Analyzer Core（同 `/workflows analyze`） | 无 critical/high；`quality-loop.js` 仅 1 条 low（SERIAL-001，串行数据依赖属预期） |
| 注册 | `addToManifest()` 真链路（与 `/workflows register` 同一函数） | 5/5 注册成功，脚本原位 |

测试覆盖的关键分支：

1. judge 直接 `converged` 时**不调用** fixer（3 次 agent）；
2. judge `continue` → fixer → 复审 → 复裁收敛（6 次 agent，`roundsCompleted=2`）；
3. 修复轮数耗尽返回 `continue`，不进入第二轮修复；
4. 实施阶段 `escalate` 立即返回，不进入评审；
5. 四个角色档位可分别覆盖，且各角色缺省档位正确路由。

## 5. 遗留项

1. ~~真实模型联调未跑~~ → 已完成，见第 7 节。
2. 顶层 `/coder`、`/reviewer`、`/judge`、`/fixer`、`/quality-loop` 直跑命令需重启 pi 会话后出现在补全列表（宿主限制，会话内用 `/workflows run <id>`）。
3. 组合层暂未做多 reviewer 并行、inspector 发布门禁、collector 外部证据；按计划第 13 节门槛，待真实使用信号再加。

## 5.1 内置区域（2026-11-20 追加）

内置不再靠注册：注册表在项目条目之后自动并入包根 `workflows/*.js`，顶层斜杠命令也无条件注册内置（不再依赖 manifest 存在）。

- 解析：`builtinWorkflowsDir()` 沿 `import.meta.url` 上溯到包根 `workflows/`，递归扫描分类子目录（`roles/`、`flows/`…），按 `meta.id` 寻址、目录不参与 id；`src`/`dist` 两种运行形态一致；单文件解析失败带 `workflows/<分类>/<文件>` 上抛。
- 保留 id：项目 manifest 与 legacy 目录均禁止使用内置 id；发现同名立即报错，防止顶层命令错跑。
- 保留 id：`/workflows register` 用内置 id 报"内置 workflow 的保留 id"并拒绝；`/workflows unregister <内置>` 明确提示不可注销。
- 视图：`/workflows list` 分「项目注册 / 内置（随包分发，无需注册）」两段；`unreg` 补全不再列内置，`run` 补全包含内置。
- 测试：新增 `tests/contract/builtin-workflows-registry.test.ts` 6 条（零注册可解析 / legacy 模式可见 / 保留 id 拒绝 / 不可注销 / 项目优先 / 不可用 id 判定），并更新直跑注册、补全、registry 相关断言。engine 218/218、contract 239/239 全绿。

## 6. 后续使用方式

五个都是内置 workflow，装上插件即生效，无需注册。日常调用使用**自然语言简写**：命令后的整段文字自动成为 `task`；不传档位时使用已确认的角色缺省档位（coder/fixer=`fast`，reviewer/judge=`big`）。

```text
/quality-loop 修复登录接口超时重试
/coder 修复登录接口超时重试
/reviewer 评审当前工作区改动
```

只有临时覆盖默认行为时才写显式参数：

```text
/quality-loop task="修复登录接口超时重试" maxRepairRounds=2 coderTier=big judgeTier=ultra
/coder task="修复登录接口超时重试" tier=big
```

同一行不要混用裸文本与 `key=value` 参数；有高级参数时，将任务也写成 `task="..."`。例如 `/fixer` 需要结构化 `findings=[...]`，因此必须使用显式参数形态。

## 7. P3 宿主联调（2026-11-20，真实模型）

方式：`BILI_PI_INLINE=1 pi -ne -e . --print`（只加载本插件），主会话只负责调用 `workflow` 工具，证据以 journal + 各类 run 日志为准。沙盒目标文件：`dev-examples/builtin-roles-smoke/calc.js`（初始人为植入 bug：`add` 返回 `a - b`）。

| 步骤 | 命令形态 | runId | 结果 |
| --- | --- | --- | --- |
| P3-1/P3-2 宿主冒烟 + 预热 | 内联脚本 `agent('只回复 ok', {tier:'fast'})` | `run-1795399467730-dcfqsu` | 1 agent ok 1547ms；journal 记录 model=`deepseek-v4.1-flash-official`，证明 `fast` 档解析生效 |
| P3-3 实施（fast） | `scriptPath="coder"`，`tier=fast` | `run-1795399491514-mbvx5o` | status=completed 41.4s；真实修好 `add` 并新增 `calc-check.js`；`node calc-check.js` exit=0 |
| P3-3 评审（big） | `scriptPath="reviewer"`，`tier=big` | `run-1795399566274-t4lm49` | status=completed 50.5s；独立发现真实问题（`logs/` 未被 .gitignore 覆盖），并自证负向用例能捕获原 bug |
| P3-4 质量闭环 | `scriptPath="quality-loop"` | `run-1795399646403-haucnz` | 6 agent / 10 阶段 / 249s；coder→reviewer→judge(continue)→fixer→reviewer→judge(converged)；`roundsCompleted=2` |

P3-4 关键观察（证明闭环的每道闸都真的在工作）：

1. 第 1 轮 judge 判 `continue`（功能已满足，但上一条 low finding 连续两轮未修），findings 被正确交给 fixer；
2. fixer 只改 `.gitignore` 一行（根因处修复），未扩大范围；
3. 复审只跑了 18.2s（增量核对），第 2 轮 judge 判 `converged`；
4. 最终产物验证：`git check-ignore` 命中 `.gitignore:23`，`calc.js`/`calc-check.js` 仍可入库。

**联调中顺手修掉的口径问题**：起初 `/coder task="两个 词"` 这类带空格的成句参数会被 `/\s+/` 切碎（顶层直跑与 `/workflows run` 两条路径都是），现已抽出共享的 `splitCommandArgs()`（`src/tools/workflow-tools.ts`）支持 `"..."` / `'...'` 包裹。随后又支持了推荐的自然语言简写：`/coder 修复登录超时` 自动转换为 `{ task: "修复登录超时" }` 并使用角色默认档位；高级参数存在时仍使用 `task="..."`。两条命令路径共用解析器并有 contract 测试覆盖。

**发现的行为特征**：第 1 轮 reviewer 触发一次 schema 修复循环——模型给出了缺 `recommendation` 的 finding，adapter 校验失败后重试通过（该次 138s）。这是 schema 契约生效的预期表现（要求每条 finding 可执行），不是缺陷；若后续频繁发生，再考虑放宽 `recommendation` 为可选。

证据文件（已 gitignore，不入库）：`dev-examples/builtin-roles-smoke/logs/A-host-warmup.log`、`B-coder-fast.log`、`C-reviewer-big.log`、`D-quality-loop.log`，以及 `.pi/workflows/journal/run-17953994*.json`。
