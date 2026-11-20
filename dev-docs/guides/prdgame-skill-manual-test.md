# 手动测试手册：用 PrdGameSkill 验收 pi-code-mode

- 日期：2026-11-19
- 测试对象：`thirdparties/PrdGameSkill/.opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js`（S1~S11 主编排 + 11 子流程）
- 目标：用真实生产 workflow 验证 pi-code-mode 的 **Analyzer / Plan / 预算治理 / 任务级恢复 / 评估基线** 是否正确工作
- 本手册三档递进：**第1档零成本（秒级）→ 第2档零成本（秒级）→ 第3档真实运行（分钟级，消耗 token）**

## 命令使用约定（先读，避免走错入口）

**优先用 pi 会话内的斜杠命令，不要退出 pi 去跑 `node bin/...`。**
所有能力都有三个入口，优先顺序如下：

| 优先 | 入口 | 何时用 |
| --- | --- | --- |
| 1 | `/workflows <子命令>` | 在 pi 里工作时（推荐） |
| 2 | `workflow_analyze` / `plan_validate` 工具 | Agent 自动调用 / 需要结构化返回 |
| 3 | `pi-code-mode <子命令>` CLI | 不在 pi 会话里（CI、终端脚本） |

本手册凡涉及分析/校验的步骤，均已改用**会话内命令**；仅跨仓库批量扫描（1.4）仍需终端。

### 命令速查表

```
/workflows analyze <路径|名> [--no-suggest]   静态分析 + AI 建议（别名 anal；报告自动落盘）
/workflows plan validate <plan.json>      校验 Plan（Profile 边界/指纹/过期）
/workflows run <路径|名> [k=v...]         后台执行 workflow
/workflows resume <路径|名> [--tasks]     任务级恢复（只重跑未完成）
/workflows resume <路径|名> --status      查看任务清单与状态
/workflows status <runId>                查看运行详情
/workflows cancel [runId]                停止运行
```

---

## 0. 前置准备

### 0.1 让 PrdGameSkill 加载本插件

```bash
cd /e/WorkProjects/PrdGameSkill
pi-code-mode install
# 首次启动 pi 会弹 project trust 确认，授权一次永久生效
```

卸载：`pi-code-mode remove`；查看插件路径：`pi-code-mode path`。

### 0.2 临时方式（不改配置）

```bash
cd /e/WorkProjects/PrdGameSkill
pi -e E:/WorkProjects/pi-code-mode
```

### 0.3 测试背景基线（先读，便于判断结果是否正常）

来自 `dev-docs/benchmark/m1-baseline.json`（PrdGameSkill 历史 58 个 run）：

| runId | Agents | P50 耗时 | 最大单 Agent | failed |
| --- | --- | --- | --- | --- |
| run-mwkpasup-2 | 140 | 14.1 min | 59 min | 17 |
| run-mwfb5d3r-7 | 86 | 8.9 min | 68.3 min | 2 |
| run-mwep59gd-1 | 64 | 10.2 min | 57.7 min | 17 |

**结论**：这是分钟级长任务，必须带看门狗；单 Agent 长尾是主要墙钟来源。

---

## 第 1 档：静态分析（零成本，秒级）

### 1.1 单脚本分析（pi 会话内命令）

**在 PrdGameSkill 里启动 pi 后**，直接输入斜杠命令（`anal` 是 `analyze` 的别名）：

```
/workflows analyze .opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js
/workflows anal .opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js
```

**实测期望输出**（会话内摘要，2026-11-19）：

```
Analyzer: .opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js
风险分 2/100
调用点 5（估算任务 4，含动态为下限） · 动态节点 5

[LOW] RETRY-001 L129-137 (conf 0.80)
  retries 最高 2 次

完整报告：.pi/workflows/reports/game-requirement-audit.analysis.md
```

> 会话内只显示摘要（报告常达数百行，notify 会截断）；完整 Markdown/JSON 自动落盘到
> `.pi/workflows/reports/`。看全文用 `read` 工具读取该文件。

**检查点**：

- [ ] `风险分` 是个位数（真实脚本无重大静态缺陷）
- [ ] `动态节点 5` 有值（说明动态边界识别工作）
- [ ] 标了「含动态为下限」（说明没有伪造精确数字）
- [ ] 没有出现 `INPUT-001`（历史上这里曾有 17 条误报，见 `dev-docs/experience/analyzer-input-001-false-positives.md`）

### 1.2 报告落盘（命令自动完成）

`/workflows analyze` 每次都会同时写 Markdown 与 JSON，无需额外参数：

```
/workflows analyze .opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js
```

**检查点**：

- [ ] `.pi/workflows/reports/game-requirement-audit.analysis.md` 存在
- [ ] `.pi/workflows/reports/game-requirement-audit.analysis.json` 存在
- [ ] 报告内含 `callGraph` / `dependencies` / `recommendations` 字段

### 1.3 AI 优化建议（默认开启，不用加参数）

`/workflows analyze` **默认就会生成 AI 优化建议**（会真实调用模型，消耗 token）。直接跑：

```
/workflows analyze .opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js
```

只想看静态结果、省 token 时关闭：

```
/workflows analyze .opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js --no-suggest
```

等价的工具调用（脚本用 `scriptPath`）：

```
workflow_analyze({
  scriptPath: ".opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js",
  includeSuggestions: true,
  format: "md"
})
```

**检查点**：

- [ ] 返回含 `recommendations`（AI 建议）
- [ ] 每条建议的 `expectedImpact` 是「待 Benchmark」，**没有虚构百分比收益**
- [ ] 每条建议有 `validation` 验证条件

### 1.4 全量扫描（13 个真实脚本 + 主编排）

全量扫描是跨仓库脚本（不是 pi 命令），需在插件仓库跑：

```bash
cd /e/WorkProjects/pi-code-mode
npx tsx dev-examples/prdgame-skill-acceptance/scan-analyzer.mts
```

> 日常单文件排查优用 `/workflows analyze`（会话内，自动落盘）。多文件横向对比才需要跑全量扫描。

**实测期望**（2026-11-19，INPUT-001 误报修复后的基线）：

```
32/36 个脚本有 finding；27 个含动态节点；平均风险分 6
```

**检查点**：

- [ ] 平均风险分在 5~10 区间（修复前是 24，说明误报已收敛）
- [ ] 没有任何脚本出现「十几条同一 ruleId」的形态（那是误报信号）
- [ ] 结果落盘 `dev-examples/prdgame-skill-acceptance/results/analyzer-scan.json`

---

## 第 2 档：Plan 校验（零成本，秒级）

### 2.1 生成示例 Plan

若 `.pi/workflows/plans/game-requirement-audit.plan.json` 不存在，用下面命令生成（11 stage 对齐 S1~S11）：

```bash
cd /e/WorkProjects/PrdGameSkill
node -e "
const fs=require('fs'),crypto=require('crypto');
const p='.opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js';
const src=fs.readFileSync(p,'utf8');
const h='sha256:'+crypto.createHash('sha256').update(src).digest('hex');
const plan={
  planVersion:'1.0', workflowId:'game-requirement-audit', name:'游戏需求审计 S1~S11',
  source:{scriptPath:p, scriptHash:h},
  definition:{
    stages:[
      {id:'S1',name:'需求扫描',type:'sequential',estimatedAgents:1},
      {id:'S2',name:'原子拆解',type:'sequential',estimatedAgents:1},
      {id:'S3',name:'注册表定稿',type:'sequential',estimatedAgents:1},
      {id:'S4',name:'客户端查证',type:'parallel',dependsOn:['S3'],estimatedAgents:20},
      {id:'S5',name:'服务端查证',type:'parallel',dependsOn:['S3'],estimatedAgents:20},
      {id:'S6',name:'证据汇总',type:'sequential',dependsOn:['S4','S5'],estimatedAgents:1},
      {id:'S7',name:'业务行为还原',type:'sequential',dependsOn:['S6'],estimatedAgents:2},
      {id:'S8',name:'统一差异复核',type:'parallel',dependsOn:['S7'],estimatedAgents:2},
      {id:'S9',name:'L7分类',type:'sequential',dependsOn:['S8'],estimatedAgents:1},
      {id:'S10',name:'统一规格生成',type:'sequential',dependsOn:['S9'],estimatedAgents:3},
      {id:'S11',name:'人工裁决',type:'sequential',dependsOn:['S10'],estimatedAgents:1}
    ],
    quality:{requiredValidation:true, acceptanceCriteria:['所有 stageId 均有查证结论','关键差异带来源证据','需求覆盖率不下降']}
  },
  profiles:{
    fast:{mode:'fast',concurrency:{max:8}},
    balanced:{mode:'balanced',concurrency:{max:4},budget:{maxAgents:120,maxDurationMs:3600000}},
    quality:{mode:'balanced',concurrency:{max:4},additionalValidation:['交叉评审']}
  }
};
fs.mkdirSync('.pi/workflows/plans',{recursive:true});
fs.writeFileSync('.pi/workflows/plans/game-requirement-audit.plan.json',JSON.stringify(plan,null,2));
console.log('plan written');
"
```

### 2.2 校验 Plan（pi 会话内命令）

```
/workflows plan validate .pi/workflows/plans/game-requirement-audit.plan.json
```

**实测期望**：

```
- 结果：PASS
- 默认 Profile：balanced
- Profiles：fast, balanced, quality
- planHash 一致：未声明
- 脚本是否已过期：否

## Profile 解析
- fast: mode=fast concurrency=8 requiredValidation=true
- balanced: mode=balanced concurrency=4 requiredValidation=true
- quality: mode=balanced concurrency=4 requiredValidation=true +验证[交叉评审]
```

**检查点**：

- [ ] 三个 Profile 的 `requiredValidation=true`（强制验证不可被 Profile 关闭）
- [ ] 只有 quality 带 `+验证[交叉评审]`（Profile 只能追加验证）

### 2.3 验证 Plan 过期检测

改动脚本（追加一行注释）后重跑 2.2：

```
/workflows plan validate .pi/workflows/plans/game-requirement-audit.plan.json
```

（用 `edit` 工具或编辑器给脚本追加一行注释即可；无需 shell 重定向）

**检查点**：

- [ ] 输出 `脚本是否已过期：**是**（需重新 analyze）`

**测试完请还原**：在 PrdGameSkill 仓库执行 `git checkout -- .opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js`

### 2.4 验证 Profile 削弱拦截

手工把 `quality` 里加上 `"requiredValidation": false`，重跑 2.2：

**检查点**：

- [ ] 输出 `结果：FAIL` + 错误路径 `profiles.quality.requiredValidation`

---

## 第 3 档：真实运行（分钟级，消耗 token）

> **纪律**（来自 CLAUDE.md）：长任务必须预热模型、必须带看门狗、证据以落盘为准、并发 ≤2。

### 3.0 先预热模型

在 pi 里发一句 `只回复 ok`，确认 provider 正常再继续。

### 3.1 启动（带看门狗）

```bash
cd /e/WorkProjects/PrdGameSkill
timeout 3600 pi -e E:/WorkProjects/pi-code-mode
```

`timeout 3600` = 1 小时硬上限，超时自动终止（历史最大单 Agent 68 min，留足余量）。

### 3.2 最小可控起点（推荐先跑这个）

不要一上来跑全量 S1~S11。先只出计划：

```
/workflows run .opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js \
  date=2026-11-19 mode=from-stage startStage=S1 planOnly=true step=true
```

说明：

- `planOnly=true`：from-stage 只出执行计划并 checkpoint 确认，不真正跑 agent
- `step=true`：每阶段完成后 checkpoint，拒绝即正常停止且产物保留

**检查点**：

- [ ] 返回 runId
- [ ] 产物根出现：`spec-workflow/requirement-audit/2026-11-19/runs/<runId>/`
- [ ] 出现 checkpoint 确认提示（说明人工闸门工作）

### 3.3 任务级恢复入口（本插件核心能力）

启动并启用 TaskRegistry：

```
/workflows resume .opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js --tasks
```

查看任务清单（不执行）：

```
/workflows resume .opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js --status
```

**期望输出**：

```
任务清单：game-requirement-audit（共 N）
  done X / failed Y / running Z / pending W

  [done] audit:...:0  gen=1 attempt=1 123s
  [failed] audit:...:5  gen=2 attempt=1 err=...
```

**检查点**：

- [ ] 有 `done/failed/running/pending` 统计
- [ ] 每条任务有 `gen`（Fencing Token）与 `attempt`
- [ ] 失败任务带 `err` 摘要

### 3.4 验证「只重跑失败任务」

首次跑完后（若有 failed）：

```
/workflows resume .opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js --tasks
```

**检查点**：

- [ ] 日志/输出中出现 `复用`（已完成任务不再调用 agent）
- [ ] `--status` 中 done 数量不减少
- [ ] 只有 failed/pending 的任务真正执行

### 3.5 验证 Plan 预算真的生效

用 Plan 跑（把 `balanced` 的 `maxAgents` 改小，比如 3）：

```
/workflows run .opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js \
  date=2026-11-19 planPath=.pi/workflows/plans/game-requirement-audit.plan.json
```

**检查点**：

- [ ] 跑满 3 个 agent 后出现预算拦截错误（`预算拦截：agent 数已达上限 3`）
- [ ] 不传 `planPath` 时不受该限制（旧行为兼容）

**测试后请把 maxAgents 改回 120。**

### 3.6 验证评估基线写入

Plan 运行成功后：

```bash
ls /e/WorkProjects/PrdGameSkill/.pi/workflows/baseline/
```

**检查点**：

- [ ] 出现 `game-requirement-audit__<scriptHash前16位>.json`
- [ ] 内含 `samples[].{agents,durationMs,inputTokens,failedAgents}`
- [ ] `stats` 内有 `p50/p90/max`

第二次跑同一 Plan 后：

- [ ] `samples` 长度增加
- [ ] 若本次更慢，`detectRegression` 会在 evaluation 中标记 `regressed: true`

### 3.7 验证 Benchmark（可选，需工作区脚本）

```
workflow_benchmark({
  scriptPath: ".opencode-workflows/workflows/game-requirement-audit/game-requirement-audit.js",
  planPath: ".pi/workflows/plans/game-requirement-audit.plan.json",
  profile: "balanced"
})
```

**检查点**：

- [ ] 输出两行耗时对比（before/after 真实墙钟）
- [ ] 若 Required Validation 无验证结果 → 结论为**未通过**（不默认放行）
- [ ] 无 ≥5% 改善时明确说「未测得 ≥5% 的指标改善」

---

## 4. 问题排查对照表

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `analyze` 报脚本不存在 | 未在 PrdGameSkill 项目根执行 | `cd /e/WorkProjects/PrdGameSkill` 后重跑 |
| `waves` 显示 `-` | 脚本用动态 `parallel(...map)`，任务数静态不可知 | **正常**，Analyzer 按设计不伪造数字 |
| `类似标识符出现在 N 个调用` 大量刷屏 | INPUT-001 回归（误报） | 检查 `dev-docs/experience/analyzer-input-001-false-positives.md` 的准入条件是否被改坏 |
| Plan 一直报「已过期」 | 脚本确实改过，或只传了 planPath 未传 scriptPath | 重新 `analyze` 后更新 `source.scriptHash` |
| `--tasks` 第二次仍重跑全部 | 脚本前部插入了 agent（调用序号平移）导致指纹全变 | 预期行为：复用归零但不会错误复用 |
| 预算拦截没生效 | 未传 `planPath` | 传 `planPath` 才会注入 BudgetGate（旧 workflow 零改动是设计目标） |
| `workflow_benchmark` 直接报「未配置执行器」 | 工具被单独调用未接 runOnce | 用扩展注册的实例（自动接了真实 run） |
| 真实跑超时 | 单 Agent 长尾（历史 68 min） | 提高 `timeout`，或先用 `step=true` 分阶段确认 |

---

## 5. 验收记录表（打印填写）

| # | 检查项 | 期望 | 实际 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | analyze 风险分 | 个位数 | | |
| 2 | 无 INPUT-001 刷屏 | 0 条 | | |
| 3 | 全量扫描平均风险 | 5~10 | | |
| 4 | plan validate | PASS + 三 Profile requiredValidation=true | | |
| 5 | Plan 过期检测 | 改脚本后报「已过期」 | | |
| 6 | Profile 削弱拦截 | 声明 requiredValidation 后 FAIL | | |
| 7 | 最小可控运行 | 产出 runId + 产物目录 + checkpoint | | |
| 8 | `--status` | 任务清单 + gen/attempt | | |
| 9 | `--tasks` 恢复 | 已完成任务复用、只跑失败 | | |
| 10 | Plan 预算拦截 | maxAgents=3 时第 4 个被拦 | | |
| 11 | 评估基线 | baseline 文件 + samples 增长 | | |
| 12 | Benchmark | 真实耗时对比 + Required Validation 拒绝放行 | | |

---

## 6. 相关文档

- Analyzer 误报修复经验：`dev-docs/experience/analyzer-input-001-false-positives.md`
- M1 基线数据：`dev-docs/design/m1-baseline.md`、`dev-docs/benchmark/m1-baseline.json`
- 执行计划（M1-M6）：`dev-docs/planning/2026-11-18-workflow-engineering-execution-plan.md`
- 生产就绪审计：`dev-docs/troubleshooting/2026-11-18-m1-m5-production-readiness-audit.md`
- 扫描脚本：`dev-examples/prdgame-skill-acceptance/scan-analyzer.mts`
