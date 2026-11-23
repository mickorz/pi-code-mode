# 内置角色工作流使用指南

本包内置五个可直接运行的 workflow：四个单角色工作流（`coder` / `reviewer` / `judge` / `fixer`）和一个组合闭环（`quality-loop`）。它们把“实施、独立评审、裁决、修复”拆成互不隐式调用的独立环节，由你决定每次跑哪些、用什么模型。

这五个是**内置**工作流：脚本随包分发，装好插件就能用，**不需要注册**。它们和"项目自有工作流"是两个独立区域，见第 2 节。

内置脚本按分类放在包内 `workflows/` 的子目录里，目录只用于人类组织，**不参与 id 解析**（寻址一律用 `meta.id`）：

```text
workflows/
  roles/           # 单角色：一个脚本一个职责
    coder.js
    reviewer.js
    judge.js
    fixer.js
  flows/           # 组合流程：编排角色，自身不调模型
    quality-loop.js
```

后续新增的内置工作流按类别继续开子目录（如 `flows/`、`checks/`），扫描是递归的。

## 1. 五个工作流一览

| workflowId | 职责 | 是否改代码 | 缺省档位 |
| --- | --- | --- | --- |
| `coder` | 按任务改代码、构建与测试、如实报告 | 是 | `fast` |
| `reviewer` | 只读独立评审，输出带证据的 findings | 否 | `big` |
| `judge` | 依据任务、改动与评审证据裁决 | 否 | `big` |
| `fixer` | 只修已确认的 findings，在根因处修净 | 是 | `fast` |
| `quality-loop` | 组合：coder → reviewer → judge →（continue 时）fixer → 复审 → 复裁 | 条件性 | 按角色缺省 |

四个角色互不隐式调用。`quality-loop` 是唯一的默认组合，通过注册名调用这四个角色，不复制它们的提示词。

## 2. 两个区域：内置 与 项目注册

工作流分两个独立来源，用 `/workflows list` 可以分开看到：

| 区域 | 位置 | 是否需要注册 | 说明 |
| --- | --- | --- | --- |
| **内置** | 插件包的 `workflows/<分类>/` 目录（随包分发） | **不需要**，装上即生效 | `coder` / `reviewer` / `judge` / `fixer` / `quality-loop` |
| **项目注册** | `.pi/workflows/register.json` + 你项目里的脚本 | 需要 `/workflows register` | 你自己的业务工作流 |

### 2.1 内置：零配置

插件加载时自动把包内 `workflows/*.js` 并入注册表，并按 `meta.id` 直接注册为顶层斜杠命令。所以装好插件、启动会话后直接可用：

```text
/coder 修复登录接口的超时重试问题
/quality-loop 在 calc.js 新增 mul(a,b) 并补一条断言
```

第一段文字就是任务描述，不需要 `task=`；模型档位用各角色缺省值，不用传 `tier=`。

补充约定：

- 内置 id 是**保留 id**：项目侧再用同 `meta.id` 注册会被拒绝（避免同名两套实现语义漂移）。想自定义就换个 id。
- 内置**不可注销**：`/workflows unregister coder` 会明确提示这是内置；`/workflows unreg` 的补全里也不列内置。
- 内置脚本坏掉时会带 `workflows/<分类>/<文件>` 报解析错误（不静默跳过）——那是包自身缺陷，应修包。
- 项目条目和 legacy 目录都**不能**使用内置 id；发现同名即报错，防止顶层命令静默丢失或错跑项目脚本。

### 2.2 项目自有工作流：按需注册

```text
/workflows register .pi/workflows/my-flow.js
```

注册只把脚本原位路径写进 manifest，不复制脚本。`quality-loop` 按**内置 id** 找四个角色，因此它也无需注册；只有你自己写的组合脚本若按名引用别的项目工作流，才需要那些工作流先注册。

### 2.3 档位（模型）

档位名来自 `.pi/workflows/model-tiers.json` 的 `tiers` 键（项目级优先，全局 `~/.pi/workflows/model-tiers.json` 兜底）：

```json
{
  "tiers": {
    "fast": "cc-switch-zhipu-glm-copy/deepseek-v4.1-flash-official",
    "big": "cc-switch-zhipu-glm-copy/BF_ULTRA",
    "ultra": "cc-switch-zhipu-glm-copy/gpt-5.6-terra"
  }
}
```

- 每个角色缺省档位见上表，可用 `tier`（或对 `quality-loop` 用 `coderTier` 等）逐次覆盖。
- 档位解析不到时打印 warning 并回退会话默认模型；不会硬编码任何 provider/model。
- 换档不需要改脚本。

## 3. 参数与调用语法

两种写法，任选其一：

1. **自然语言（推荐日常用）**：命令后整段文字就是任务，落到 `args.task`。

   ```text
   /coder 修复登录接口的超时重试问题
   /reviewer 评审当前工作区里登录超时的改动
   /quality-loop 在 calc.js 新增 mul(a,b) 并补一条断言
   ```

2. **显式参数**：`key=value`，值支持 JSON 字面量（`true`、`2`、`["a","b"]`），非 JSON 按字符串处理；值里有空格要加引号。

   ```text
   /coder task="修复 登录接口 超时重试" tier=big
   /quality-loop task="实现支付回调幂等" maxRepairRounds=2 judgeTier=ultra
   ```

**不要混用**：同一行里既有 `key=value` 又有裸词会报错（歧义不猜）。模型档位平时不用传，各角色有缺省值（第 1 节表格）；只有想临时换档时才写 `tier=...`。

### 3.1 `coder`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `task` | 是 | 要实施的任务 |
| `validation` | 否 | 字符串数组，验证命令或验收条件 |
| `tier` | 否 | 缺省 `fast` |

```text
/coder 修复 dev-examples/calc.js 里 add 的错误实现，并新增 node:assert 自检脚本
/coder 修复 add 的错误实现 validation=["npm run build","npm test"]
/workflows run coder 修复 add 的错误实现
```

输出 `status`：`completed`（已改并报告验证）或 `escalate`（缺授权、需求不清、缺资源）。

### 3.2 `reviewer`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `task` | 是 | 本次评审对应的任务目标（判断改动是否对题） |
| `focus` | 否 | 额外关注点，如 `correctness,security` |
| `base` | 否 | 对比基线（如 `main`）；缺省看当前工作区改动 |
| `tier` | 否 | 缺省 `big` |

```text
/reviewer 评审当前工作区里 add 修复与自检脚本
/reviewer task="评审本分支改动" base=main
```

输出 `status`：`completed`（findings 可为空）或 `escalate`。`findings[]` 每项含 `severity` / `location` / `evidence` / `recommendation`。

### 3.3 `judge`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `task` | 是 | 裁决对应的任务目标 |
| `materials` | 否 | 上游结论（字符串数组，通常是 coder / reviewer 的输出 JSON） |
| `findings` | 否 | 待裁决的 findings 数组 |
| `tier` | 否 | 缺省 `big` |

```text
/judge 裁决 add 修复是否可接受
/judge task="裁决改动" materials=["<coder 输出 JSON>","<reviewer 输出 JSON>"]
```

输出 `status`：`converged` / `continue` / `escalate`。

### 3.4 `fixer`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `task` | 是 | 修复的任务背景 |
| `findings` | 是 | 待修复的 findings 数组（一般来自 judge） |
| `validation` | 否 | 字符串数组，验证要求 |
| `tier` | 否 | 缺省 `fast` |

缺 `findings` 直接报错（不会跑一次空修复）。

```text
/fixer task="修复评审提出的问题" findings=[{"severity":"low","location":".gitignore:22","evidence":"logs 未被忽略","recommendation":"追加忽略规则"}]
```

`fixer` 的 findings 是结构化数组，必须用 `key=value` 形态传，不适合自然语言简写。

输出 `status`：`completed` 或 `escalate`（需要用户决策 / 前提不成立）。

### 3.5 `quality-loop`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `task` | 是 | 任务目标 |
| `validation` | 否 | 验证命令或验收条件 |
| `maxRepairRounds` | 否 | 修复轮数上限，`1`（缺省）或 `2` |
| `coderTier` | 否 | 缺省 `fast` |
| `reviewerTier` | 否 | 缺省 `big` |
| `judgeTier` | 否 | 缺省 `big` |
| `fixerTier` | 否 | 缺省 `fast` |

```text
/quality-loop 在 calc.js 新增 mul(a,b) 并在自检脚本加断言 mul(3,4)===12
/quality-loop task="实现支付回调幂等" coderTier=big judgeTier=ultra maxRepairRounds=2
```

拓扑与停机条件：

```text
coder → reviewer → judge
                     ├─ converged → 结束（交你检查变更）
                     ├─ escalate  → 结束（等你的决策）
                     └─ continue  → fixer → reviewer → judge（最多 maxRepairRounds 轮修复）
```

轮数耗尽仍为 `continue` 时返回未收敛结果，不会无限循环。

输出：

```json
{
  "status": "converged | continue | escalate",
  "summary": "...",
  "roundsCompleted": 2,
  "nextStep": "由调用者检查变更并决定是否提交或合并",
  "stages": { "implementation": {}, "reviews": [], "judgments": [], "repairs": [] }
}
```

## 4. 常见配方

### 4.1 只想让它改代码

```text
/coder 修复 xx 问题
```

### 4.2 快模型改、强模型评（不自动修）

```text
/coder 修复 xx 问题
/reviewer 评审当前工作区改动
```

档位默认就是 coder=fast、reviewer=big，什么都不用传。

评审意见回到你手里，是否修由你决定。

### 4.3 高风险三级：改 → 评 → 裁

```text
/coder task="实现支付回调幂等" tier=big
/reviewer task="审查支付回调改动" focus="correctness,security"
/judge task="裁决支付回调改动是否可接受" tier=ultra
```

### 4.4 全自动收敛到通过

```text
/quality-loop 实现 xx 功能
/quality-loop task="..." maxRepairRounds=2
```

### 4.5 评审后按你的取舍修复

```text
/reviewer 评审当前工作区改动
/fixer task="只修我确认的问题" findings=[...]
```

## 5. 怎么读结果

四个角色的输出形状一致：

```json
{
  "status": "completed | converged | continue | escalate",
  "summary": "结论与依据",
  "findings": [
    { "severity": "critical|high|medium|low", "location": "文件:行", "evidence": "可核查事实", "recommendation": "建议动作" }
  ],
  "evidence": ["执行过的命令/测试/关键文件"],
  "nextStep": "一句下一步建议"
}
```

- `status` 是唯一可用于判断分支的字段；不要从 `summary` 文字里猜结果。
- `findings` 为空不等于任务通过——`reviewer` 空 findings 只代表没发现问题，最终判定归 `judge`。
- `evidence` 是自查依据，可据此复核模型有没有真跑命令。
- 角色输出为常规文本：提示词要求返回 JSON，脚本侧宽容提取（允许前后夹杂说明文字）；解析失败或 `status` 不在合法枚举内会明确报错，不静默降级。不用 schema 硬约束，避免宿主修复循环带来的长尾延迟。

## 6. 运行观察与证据

每次执行是一个 run，落到 `.pi/workflows/journal/`，并可在 Explorer 里按 runId 查看：

```text
/explorer                 # 打开执行观察器
/workflows status <runId> # 节点级状态
/workflows cancel <runId> # 停止在途 run（journal 保留，可 resume）
```

`quality-loop` 的每个子角色是独立子流程（journal key 形如 `runId:wf0:0`），所以能看清是哪一轮、哪个角色慢或失败。日志中的失败会写明阶段与原因（如「角色输出 JSON 解析失败」）。

## 7. 边界：它们不会做什么

四个角色都被明确禁止：

- `git commit` / `push` / `merge` / 发版 / 建 PR；
- 修改全局配置、模型档位配置、席位表；
- 用防御式代码（吞异常、空检查跳过）掩盖真实错误。

`quality-loop` 同样不自动提交或合并，最终 `nextStep` 交回给你。

## 8. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `/coder` 不存在 | 插件未加载（会话没带本扩展）或宿主占用了同名命令；`/workflows list` 看内置区是否有它 |
| `WORKFLOW_NOT_FOUND：... coder` | 包内 `workflows/` 缺文件或被删；重装插件，不要用项目注册兜 |
| 报 `不是 key=value 形式（与 key=value 混用时不允许裸词）` | 一行里混用了裸词和 `key=value`；要么整段自然语言，要么全用 `key=value` |
| 报 `既不是 key=value 也不是指令文本` | 只敲了一个字符；补全任务描述 |
| `xxx 需要 args.task` | 缺必填参数；按第 3 节补齐 |
| `fixer 需要 args.findings` | fixer 不接受空 findings；先把 judge/reviewer 的 findings 传进来 |
| 档位 warning 后仍能跑 | 档位名不在 `model-tiers.json` 里，已回退会话默认模型；补配置或换档位名 |
| 报「角色输出 JSON 解析失败 / status 非法」 | 模型没按契约给 JSON；该阶段明确失败，产物与错误写进日志，重跑即可 |

## 9. 自定义

- **换档不换脚本**：调用时传 `tier` / `coderTier` 等即可。
- **改提示词**：直接编辑 `workflows/roles/<role>.js` 里的 prompt 常量；改完跑一次语法自检 `node skills/workflow-authoring/scripts/wf-syntax-check.cjs workflows/*/*.js`。
- **加新角色**：项目里新建脚本（如 `.pi/workflows/<name>.js`），`meta.id` 唯一，返回同形状 JSON，再 `/workflows register`。是否组合进自己的闭环由你决定，不要塞进角色内部。
- **给包加内置**：放到 `workflows/<分类>/<name>.js`，`meta.id` 全局唯一；分类目录随流程族扩展，不需要改扫描代码。
- **组合方式变化**：另写一个组合脚本用 `workflow('<id>', args)` 串联，不要让角色互相调用。

## 参考

- 设计与边界：[内置角色与质量闭环 Workflow 执行计划](../dev-docs/planning/completed/2026-11-20-内置质量闭环workflow执行计划.md)
- 实现与验收记录：[内置角色 Workflow 执行报告](../dev-docs/progress-result/内置角色workflow-执行报告.md)
- 角色设计来源分析：[ak-pi-workflow-roles 封装分析](../dev-docs/research/2026-11-20-ak-pi-workflow-roles-agent-analysis.md)
- 写新 workflow：[workflow-authoring Skill](../skills/workflow-authoring/SKILL.md)
