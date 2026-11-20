# 内置角色 Workflow 执行报告

- 日期：2026-11-20
- 计划：[2026-11-20-内置质量闭环workflow执行计划](../planning/2026-11-20-内置质量闭环workflow执行计划.md)
- 前置分析：[ak-pi-workflow-roles Agent 体系封装分析](../research/2026-11-20-ak-pi-workflow-roles-agent-analysis.md)
- 参考项目：`thirdparties/ak-pi-workflow-roles`（Apache-2.0，`fbe6c7c1`），仅取“职责隔离 + 组合归调用方”方法论，未复制任何 Soul 文本或代码

## 1. 交付清单

| 文件 | 内容 |
| --- | --- |
| `workflows/coder.js` | 实施角色：改代码、构建与测试、如实报告；缺省 `tier=fast` |
| `workflows/reviewer.js` | 评审角色：只读独立评审，findings 带 location/evidence；缺省 `tier=big` |
| `workflows/judge.js` | 裁决角色：`converged / continue / escalate` 三态；缺省 `tier=big` |
| `workflows/fixer.js` | 修复角色：只处理已确认 findings，缺 findings 直接报错；缺省 `tier=fast` |
| `workflows/quality-loop.js` | 组合编排（零 agent）：coder → reviewer → judge →（continue 时）fixer → 复审 → 复裁；修复轮数默认 1、可传 2 |
| `tests/engine/builtin-roles.test.ts` | 12 条断言：解析/唯一性、单角色调用与档位、缺参报错、四条质量闭环路径、按角色档位覆盖 |
| `.pi/workflows/register.json` | 五个 workflowId 已注册（脚本原位，项目相对路径） |
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

1. **真实模型联调未跑**：全部验证使用 fake runner（无 LLM）。待按计划 P3 用低风险任务跑一次 `coder fast → reviewer big` 与一次 `quality-loop`，以 journal 为证据。
2. 顶层 `/coder`、`/reviewer`、`/judge`、`/fixer`、`/quality-loop` 直跑命令需重启 pi 会话后出现在补全列表（宿主限制，会话内用 `/workflows run <id>`）。
3. 组合层暂未做多 reviewer 并行、inspector 发布门禁、collector 外部证据；按计划第 13 节门槛，待真实使用信号再加。

## 6. 后续使用方式

```text
/quality-loop task="修复登录接口超时重试"
/coder task="修复登录接口超时重试" tier=fast
/reviewer task="评审当前工作区改动" tier=big
```

常用覆盖：

```text
/quality-loop task="..." maxRepairRounds=2 coderTier=big judgeTier=ultra
```
