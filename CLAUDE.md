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

# ① 一次性测试（不写任何配置，仅当次生效）：
pi -e $REPO

# ② 项目级常驻（推荐；写入目标项目 .pi/settings.json，随项目走）：
cd <目标项目> && pi install -l $REPO
# 首次在该项目启动 pi 会弹 project trust 确认，授权一次永久生效

# ③ 个人全局常驻（写入 ~/.pi/agent/settings.json，所有项目生效）：
pi install $REPO

# 卸载：在对应目录执行 pi remove <当初 install 的路径>
```

- 本仓库已自托管：在本仓库目录直接 `pi` 即加载（`.pi/settings.json`，commit 0e75b51）。
- 干净房间测试（跳过全部已装扩展，避免 billion-context 端口轮换干扰）：`pi -ne -e $REPO`。
- 并发两个 pi 会话时 bili 代理（127.0.0.1:18787）会端口冲突，解法：关一个 / `ACP_PORT=18799` 起新会话 / `BILI_PI_INLINE=1`（不起代理）。

## 专项约定：pi 插件与工作流联调测试

本项目是 pi agent 插件（workflow 编排引擎），联调测试涉及真实模型调用：

1. **并发上限：最多同时运行 2 个长时联调用例**（workflow run 会 fan-out 多个子代理）。需要更多用例时排队分批跑。
2. **验收类长任务前先预热检查模型可用**：用最小 prompt（如 `只回复 ok`）验证 provider 配置正常。
3. **每个联调 run 必须配看门狗**：记录子进程 PID，超时先杀子进程树再杀主进程；agent 链类验收预算 ≥20 分钟，短 flow 5-8 分钟。
4. **证据优先级**：journal + run snapshot 落盘文件 > stdout（stdout 可能截断或乱码，验收以落盘证据为准）。
5. **宿主联调用本地 dist**：pi 安装本包统一用本地路径/`pi -e` 引用本机构建产物，不要用 npm 包名形式（会走 registry 缓存按版本安装，本机 dist 改动无效）。
