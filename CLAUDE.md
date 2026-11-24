# CLAUDE.md

本仓库（pi-code-mode）的开发过程文档管理规范。

## 开发文档目录：`dev-docs/`

`dev-docs/` 是本仓库专门保存开发过程文档的目录（随仓库入库，正常提交推送）。

> 边界：仓库根 `docs/` 是**读者向**文档（随项目分发、README 链接引用）；
> `dev-docs/` 只服务开发过程，两者不混放。

### 规则

1. **所有开发过程文档必须放在 `dev-docs/` 目录下**，不要散落在仓库根目录或其他位置。
2. **新建文档时先判断类型**，放入对应类型的子文件夹；子文件夹不存在时按需创建。
3. 子文件夹按文档类型分类，命名使用小写英文和连字符（kebab-case），例如：

   | 类型 | 子文件夹 | 说明 |
   |------|----------|------|
   | 设计方案 | `dev-docs/design/` | 架构设计、技术方案、接口设计 |
   | 会议记录 | `dev-docs/meeting/` | 会议纪要、讨论记录 |
   | 问题排查 | `dev-docs/troubleshooting/` | Bug 分析、故障排查、复盘 |
   | 调研笔记 | `dev-docs/research/` | 技术调研、选型对比、学习笔记 |
   | 任务计划 | `dev-docs/planning/` | 任务拆解、进度计划、里程碑 |
   | 任务待办 | `dev-docs/todos/` | 后续计划中的任务池（backlog，尚未启动的任务想法与待办清单） |
   | 执行进度 | `dev-docs/progress/` | 阶段性进度总结、里程碑状态 |
   | 执行报告 | `dev-docs/progress-result/` | 阶段完整执行报告、验收结果（区别于 progress 的持续进度表） |
   | 使用指南 | `dev-docs/guides/` | 操作手册、环境搭建、工作流说明 |
   | 经验沉淀 | `dev-docs/experience/` | 踩坑记录、问题解决方案、经验教训 |

4. 若现有分类不适用，可新建类型子文件夹，但需保持命名风格一致，并在本文件表格中补充登记。
5. **需求/计划文档生命周期归档**：`dev-docs/design/` 中的需求文档完成后，移动到 `dev-docs/design/completed/` 下归档；`dev-docs/planning/` 中的执行/计划文档同理，完成后移动到 `dev-docs/planning/completed/`；`dev-docs/todos/` 中的待办同理，完成后移动到 `dev-docs/todos/completed/`。归档由后续会话自动执行，无需向用户确认。
6. 文档统一使用 Markdown 格式，文件名应能体现内容，例如 `2026-10-03-workflow-design.md`。
6. **自动归类，无需询问**：发现 `dev-docs/` 根目录下有未归类的文档时，直接按内容判断类型并移动到对应子文件夹，不要向用户确认。

## 进度文件夹：`dev-docs/progress/` 与报告文件夹：`dev-docs/progress-result/`

`dev-docs/progress/` 专门用于记录项目阶段性执行进度；`dev-docs/progress-result/` 专门用于沉淀阶段完整执行报告（区别于 progress 的持续进度表：progress 是滚动维护的状态，progress-result 是一次成稿的阶段报告）。

### 规则

1. **阶段完成必须记录**：每完成一个阶段/里程碑，必须更新进度文档，不得只提交代码不更新进度。
2. **双文件夹同步更新**：每次执行完一个里程碑，除更新 `dev-docs/progress/` 外，还必须同步更新 `dev-docs/progress-result/` 中的对应阶段执行报告（新建或追加）。两个文件夹缺一不可。
3. **每阶段独立报告文件**：阶段报告按阶段命名（`P0-执行报告.md`、`P1-执行报告.md`、`P2-执行报告.md`...），**新阶段内容必须写入新文件，禁止向其他阶段的报告文件追加**（含 `cat >>`）。已完成阶段的报告视为只读；报告内引用其他阶段（如"P2 方向"）允许，但不承载其他阶段的执行记录。
4. **进度文档要求维护到位**：更新 `dev-docs/progress/执行进度.md`（持续维护的总进度文档）中的里程碑状态表，并视情况为该阶段新建独立进度/验收文档；记录内容包括：完成时间、交付清单、commit 记录、经验索引、遗留问题。
5. **进行中也要反映**：阶段启动、中途重要节点（如架构决策、验收通过/失败）都应同步到进度文档，保证文档与仓库实际状态一致。
6. 新的进度文档放入本文件夹，命名体现阶段或日期，例如 `P0-验收报告.md`、`2026-10-03-执行进度.md`。

## 经验文件夹：`dev-docs/experience/`

`dev-docs/experience/` 专门用于沉淀开发过程中遇到的坑点和解决方案。

### 规则

1. **遇到坑必须记录**：开发中碰到坑（如环境问题、依赖冲突、隐蔽 Bug、反直觉行为等）并解决后，将问题现象、原因分析、解决步骤记录到 `dev-docs/experience/` 下，一篇文档记录一个问题。
2. **解决问题前先查经验**：每次遇到问题时，必须先到 `dev-docs/experience/` 下查找是否之前碰到过类似问题：
   - 若有记录，优先按已有经验尝试解决，解决后视情况补充更新原记录（如新的解决方法、适用版本变化）。
   - 若无记录，解决完成后再将完整过程沉淀为新文档。
3. 经验文档建议结构：**问题现象 → 排查过程 → 根因 → 解决方案 → 预防/注意事项**，文件名体现问题关键词，例如 `node-version-conflict.md`。

## 示例目录：`dev-examples/` —— 开发期沙盒

1. 开发中的脚本试验、联调配置与临时输出一律放 `dev-examples/`（一主题一子目录，kebab-case），
   **不对读者负责**，内容可随时失效或删除，不进 README 宣传、不被其他文档引用。
2. 运行产物（日志、临时输出、node_modules 等）加入 .gitignore 不提交；目录本身与试验脚本随仓库入库。详细约定见 `dev-examples/README.md`。
3. 毕业路径：`dev-examples/` 里验证通过 → 合入正式代码 → 必要时在 `docs/` 落地读者向文档 → 删除沙盒里对应目录。

## 第三方参考项目：`thirdparties/` 与清单 `thirdparties/REFERENCES.md`

`thirdparties/` 存放只读的外部参考项目（本地目录或 Git Submodule）；`thirdparties/REFERENCES.md` 是参考项目清单（地址、License、固定 commit、研究目的），随仓库入库。

### 规则

1. **引入必登记**：每引入一个第三方项目（无论本地目录还是 Submodule），必须同步更新 `thirdparties/REFERENCES.md`：ID（REF-xxx 连续编号）、仓库地址、本地路径、固定 commit、License、复用策略、研究目的。
2. **只读参考**：仅用于查阅方法论、模板和文档结构，不得直接修改任何第三方项目内容。
3. **Submodule 固定 commit**：Submodule 固定明确 commit 并随仓库提交（克隆后 `git submodule update --init --recursive` 还原）；`.gitignore` 默认不忽略 `thirdparties/`，直接引入即可；不入库的本地只读目录单独追加 ignore 条目。
4. **升级方式**：本地目录用重新下载/克隆覆盖；Submodule 用 `git submodule update --remote` 固定新 commit 并更新清单。
5. **复用前检查**：复用第三方代码前核对其 License 与版权声明；无 License 的仓库只读研究、禁止复制代码。

## 开发流程：src 修改、构建与宿主安装（必读）

### 修改 src 后要测试：先 `npm run build`

**每次修改 `src/` 后、开始测试前，先跑一次 `npm run build`**，这是纪律不是可选项。原因与边界：

- **类型关卡**：单测（tsx）与 pi 宿主（jiti）都直接加载 TS 源码、**不做类型检查**，`npm run build`（tsc）是唯一能拦住类型错误的关卡——测试前必跑，防止类型错误入库。
- **宿主加载事实**（2026-11-15 实测：删 dist + 清 jiti 缓存后 `pi -e .` 全功能正常）：pi 宿主经 jiti 直载 `extensions/` 与 `src/` 的 TS 源码，所以宿主联调**改完 src 重启 pi 即生效**，不存在"测到旧 dist"；build 的意义是类型检查与发布产物（`package.json` main → `dist/index.js`），不是刷新宿主缓存。
- 更新循环三步：改 `src/` → `npm run build`（类型检查）→ 重启 pi 会话。

### 把开发中的本插件装进项目（宿主联调）

统一**本地路径安装**（直连仓库目录不拷贝、不走 npm 包名，理由见下方专项约定第 5 条）：

```bash
REPO=/Users/michaelchang/Desktop/WorkProjects/pi-code-mode

# ⭐ 最快：开发者快捷指令（npm link 已建全局软链 bin/pi-code-mode.js，任意项目目录下直接用）：
pi-code-mode install   # 按本地路径装进当前项目（自管 .pi/settings.json，绝对路径条目）
pi-code-mode remove    # 卸载
pi-code-mode path      # 打印插件仓库路径
pi-code-mode test      # 干净房间一次性测试：pi -ne -e $REPO

# ② 手动项目级（与 ① 等价，写入目标项目 .pi/settings.json，随项目走）：
cd <目标项目> && pi install -l $REPO
# 首次在该项目启动 pi 会弹 project trust 确认，授权一次永久生效

# ③ 一次性测试（不写任何配置，仅当次生效）：
pi -e $REPO

# ④ 个人全局常驻（写入 ~/.pi/agent/settings.json，所有项目生效）：
pi install $REPO
```

- 快捷指令不走 `pi install/remove` CLI，直接管理 packages 条目：规避未信任项目二次修改被拒（`Project is not trusted`）与 `pi remove` 相对路径匹配失败两个坑（2026-11-15 实测）；已用完整 pi 会话（BILI_PI_INLINE=1）端到端验证绝对路径条目加载正常。
- 本仓库已自托管：在本仓库目录直接 `pi` 即加载（`.pi/settings.json`，commit 0e75b51）。
- 干净房间测试（跳过全部已装扩展，避免 billion-context 端口轮换干扰）：`pi -ne -e $REPO`。
- 并发两个 pi 会话时 bili 代理（127.0.0.1:18787）会端口冲突，解法：关一个 / `ACP_PORT=18799` 起新会话 / `BILI_PI_INLINE=1`（不起代理）。

## extensions 命令开发规范（强制）

斜杠命令实现一律放 `extensions/commands/`，主入口 `extensions/pi-code-mode.ts` 只做装配（单例创建、依赖组装、工具注册、命令与 widget 挂载），不写命令逻辑：

1. **一命令一文件/目录**：简单命令 `commands/<命令名>.ts`，导出 `registerXxxCommand(pi, deps)` 工厂；有子命令的命令用目录 `commands/<命令名>/`。Windows 下目录与同名 .ts 不能共存，目录形态入口必须 `index.ts`。
2. **目录形态结构**：`index.ts` 路由表分发（无参数显示帮助、未知子命令报 usage）+ `types.ts` 契约（`Subcommand { usage, run(argv, ctx, deps) }`）+ 每子命令一文件；帮助面板从路由表 usage 行自动生成，同义别名指向同一实现对象自动去重。
3. **命令不持全局态**：runManager 等单例由主入口创建，经 deps 显式注入；命令需要复用工具执行链时构造对应工具工厂调用（参考 workflows/run.ts 转发 workflow 工具）。
4. **新增命令三步**：`commands/` 加文件（子命令 = 新文件 + index 路由表一行）→ 主入口一行接入 → `tests/contract/` 补路由/解析用例（无模型，fake pi + 真 RunManager）。
5. **架构守卫**：`tests/contract/commands-structure.test.ts` 强制检查「每个命令被主入口装配、每个子命令文件被 index 路由引用」，漏接即测试失败——新增文件后先跑 `npm run test:contract`。

## 大模型调用规范（强制）：一律走 model-tiers.json

**任何功能（anal / workflow / 子代理 / 分析器 / 命令）只要调用大模型，必须使用 `.pi/workflows/model-tiers.json` 中配置的档位，禁止绕过。**

### 硬性要求

1. **禁止依赖宿主默认模型**。不要写 `createPlannerAgent({ cwd })` 这类不指定模型的调用——它会落到
   `~/.pi/agent/settings.json` 的 `defaultModel`，而该默认可能是 reasoning 模型（实测 `glm-5.3-flash`
   单条规则 97s，超时频发）。
2. **禁止硬编码 provider/model**。不要写 `model: "openai/gpt-4o"` 之类具体串；模型必须来自档位配置。
3. **档位选择必须先问用户**。默认档位不是开发者自行决定的；新增调用点前用 `ask_user_question`
   确认用哪个档位（`fast` / `big` / `ultra` / 自定义档），并记录在文档里。
4. **配置缺失时显式告警**。档位解析不到要打印 warning 并回退会话默认，不能静默改变行为。

### 标准实现方式

```ts
import { loadModelTiers } from "../engine/agent/model-tiers.js"

/** tier 名 → "provider/modelId"（数组档位取首模型）；解析失败返回 undefined 供回退 */
export function resolveTierModel(tier: string, cwd?: string): string | undefined {
  const tiers = loadModelTiers({ projectDir: cwd ?? process.cwd() })
  const entry = tiers[tier]
  return typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0]?.model : undefined
}

// 调用侧：显式 model > tier > 会话默认
const model = options.model ?? resolveTierModel(options.tier ?? "<已确认的档位>", options.cwd)
```

- 已实现参考：`src/tools/workflow-analyze-tool.ts` 的 `resolveTierModel()` 与 `createPlannerAgent()`
- workflow 脚本内用 `agent(prompt, { tier: "fast" })`，由 `workflow-runtime` 经 `resolveTier` 解析
- CLI 覆盖入口：`--tier <档位>` / `--model <供应商/模型>`

### 实测依据（不要重复踩坑）

同一 prompt（REC-002 规则检查，20k 字符）在不同档位下：

| 模型来源 | 实际模型 | 耗时 | reasoning |
| --- | --- | ---: | --- |
| 宿主默认 | `glm-5.3-flash` | **97s** | true |
| `tiers.fast` | `deepseek-v4.1-flash-official` | **14.1s** | false |
| `tiers.big` | `BF_ULTRA` | 89.6s | false |

结论：**reasoning 模型用于「读代码 + 输出结构化 JSON」这类任务会慢 5~10 倍**，且更容易超时。
档位选择直接决定功能可用性，所以必须问用户而不是默认。

### 已确认的档位决策（2026-11-19，用户确认）

| 调用点 | 档位 | 说明 |
| --- | --- | --- |
| `/workflows anal` 的 AI 规则检查 | **big** | 分析用强模型；超时上限 600s（2026-11-20 用户确认） |
| `/workflows anal` 的 AI 优化建议（Planner） | **big**（与规则检查一致） | 分析类调用统一用强模型 |
| 内置 workflow `coder`（`workflows/roles/coder.js`） | **fast** | 实施与验证；`args.tier` 可覆盖 |
| 内置 workflow `reviewer`（`workflows/roles/reviewer.js`） | **big** | 独立代码评审；`args.tier` 可覆盖 |
| 内置 workflow `judge`（`workflows/roles/judge.js`） | **big** | 裁决；`args.tier` 可覆盖 |
| 内置 workflow `fixer`（`workflows/roles/fixer.js`） | **fast** | 定向修复；`args.tier` 可覆盖 |
| 内置 workflow `quality-loop`（`workflows/flows/quality-loop.js`） | 按角色缺省 fast/big/big/fast | 纯编排零 agent；`coderTier`/`reviewerTier`/`judgeTier`/`fixerTier` 分别覆盖 |
| 档位解析失败 | **告警 + 回退会话默认** | 必须打印 warning，禁止静默回退 |
| `/workflows optimize` Patch Generator | **fast** | 执行类（生成补丁）用快模型，迭代快（2026-11-20 用户确认） |
| `/workflows optimize` Patch Reviewer | **fast** | 按约束审查 diff，执行类用快模型（2026-11-20 确认） |

**分工原则（2026-11-20 用户确认）**：分析类调用（AI Rule Check / Planner / 诊断）用 `big`，允许长耗时（≤10 分钟，超时上限 600s）；执行类调用（生成补丁 / 审查 diff / 跑脚本改动）用 `fast`，要快。


新增调用点时的流程：先 `ask_user_question` 确认档位 → 在 `createPlannerAgent({ tier })` 或
`agent(prompt, { tier })` 写明 → 回填本表。

## 命令/工具改动必须自测（强制）：先 `pi -p` 跑通再交付

**任何涉及斜杠命令、工具、执行链路、参数解析的改动，改动后必须自己用 `pi -p` 端到端跑一遍，确认通过后才能告诉用户"改好了"。禁止把首次验证推给用户手动跑。**

### 为什么

之前多轮改动（optimize 后台化、`--args` 引号解析、`needsHumanDecision` 字段兼容、补丁选文件逻辑）都是**用户手动跑才暴露 bug**，其中"改错文件""命令卡死会话无响应""只回传一句详见 review.md"这三类是完全可以在交付前自测发现的。用户手动跑一次要等 4~11 分钟（big 档 AI 复核），成本极高。

### 怎么做

```bash
# 干净房间：跳过已装扩展干扰，只加载本仓库
cd <被测项目目录>
pi -ne -e /e/WorkProjects/pi-code-mode -p "/workflows optimize <target> --rules RETRY-001 --fresh --no-open"
```

要点：

1. **`-ne`**（no extensions）避免本机十几个已装 pi 包干扰；**`-e <repo>`** 用本地源码（jiti 直载 `src/`，改完立即生效，不用 build）。
2. **`-p`** 非交互，跑完即退出——能真实验证「命令注册 / 参数解析 / 后台化 / 结果回传」整条链路。
3. 长任务用 `timeout` 包住，避免自己挂死：
   ```bash
   timeout 300 pi -ne -e <repo> -p "/workflows ..."
   ```
4. **短流程优先**：先用 `dev-examples/apply-e2e/worker.js`（单轮 ~2s）验证链路，再用真实大脚本（如 `game-requirement-audit`，单次 10 分钟级）。
5. 需要固定档位时在被测项目放 `.pi/workflows/model-tiers.json`（否则会告警并回退会话默认模型——这也是要确认的行为之一）。

### 两个必知边界（实测踩过）

**1. Git Bash 会把 `/workflows` 转成 Windows 路径**

```bash
# 错误：MSYS 路径转换把 /workflows 变成 C:/Program Files/Git/workflows
pi -p "/workflows optimize ..."
# → prompt 变成普通文本，命令根本没执行（现象：无任何输出、也无产物）

# 正确：关掉路径转换
MSYS_NO_PATHCONV=1 pi -ne -e <repo> -p "/workflows optimize ..."
```

PowerShell / cmd 下没有这个问题。

**2. `pi -p` 不能验证「输出可见性」，只能验证「链路是否跑通」**

- `ctx.ui.notify` 在 print 模式下**不输出到 stdout**（TUI 弹窗在非交互模式不存在）
- `deps.deliver` 会失败：`This extension ctx is stale after session replacement or reload`
  —— print 模式在命令返回后立即结束会话，后台任务的回传通道已失效

所以 `pi -p` 的正确用法是**看产物、看状态**，不是看输出：

```bash
MSYS_NO_PATHCONV=1 pi -ne -e <repo> -p "/workflows optimize <target> --rules X --fresh --no-open"
# 然后检查
ls <project>/.pi/workflows/optimizations/*/     # session.json / review.md / optimize-report.html
node -e "console.log(require('<project>/.pi/workflows/optimizations/opt-xxx/session.json').status)"
```

要看真实输出/回传，用交互式 pi 会话，或 `--mode json` 读事件流。

### 交付前自测清单

| 检查项 | 怎么确认 |
| --- | --- |
| 命令已注册 | 不带参数的 `-p "/workflows optimize"` 能打印新版 usage |
| 参数解析 | `--args` 带/不带外层引号各跑一次；`--rules` 逗号分隔 |
| 后台化 | 命令 <2s 返回，且返回 runId + watch/status 提示 |
| 结果回传 | 结束后能看到候选摘要（不是 fallback 文案） |
| 产物落盘 | session.json / review.md / optimize-report.html 存在 |
| 不误改生产 | 被测脚本 hash 未变（optimize 阶段） |
| 早退可见 | 故意触发（如 `--rules SERIAL-002` 不加 `--unsafe-rules`）能回传原因 |

## 专项约定：pi 插件与工作流联调测试

本项目是 pi agent 插件（workflow 编排引擎），联调测试涉及真实模型调用：

1. **并发上限：最多同时运行 2 个长时联调用例**（workflow run 会 fan-out 多个子代理）。需要更多用例时排队分批跑。
2. **验收类长任务前先预热检查模型可用**：用最小 prompt（如 `只回复 ok`）验证 provider 配置正常。
3. **每个联调 run 必须配看门狗**：记录子进程 PID，超时先杀子进程树再杀主进程；agent 链类验收预算 ≥20 分钟，短 flow 5-8 分钟。
4. **证据优先级**：journal + run snapshot 落盘文件 > stdout（stdout 可能截断或乱码，验收以落盘证据为准）。
5. **宿主联调用本地 dist**：pi 安装本包统一用本地路径/`pi -e` 引用本机构建产物，不要用 npm 包名形式（会走 registry 缓存按版本安装，本机 dist 改动无效）。
