# 第三方参考项目清单（REFERENCES.md）

> 维护规则：所有第三方项目只读，不修改源码；复用代码前必须核对 License；本文件随仓库入库。
> 引入方式分两类：本地只读目录（默认也随仓库入库，重新下载/克隆覆盖更新；需排除的单独在 .gitignore 追加）与 Git Submodule（固定 commit，gitlink 入库）。
> 引入日期：逐条在表格登记时记录。

| ID | 项目 | 仓库 | 本地路径 | 固定 commit | License | 复用策略 | 研究目的 |
|---|---|---|---|---|---|---|---|
| REF-001 | opencode-dynamic-workflows | git@github.com:mickorz/opencode-dynamicworkflows.git | thirdparties/opencode-dynamic-workflows | 7f6e93abb4ff993bbcc4dd8ebb7a66e47b1f9170 | MIT | 功能蓝图：runtime 引擎与 DSL 设计移植到本包（保留版权声明） | 2026-11-14 引入。opencode 版动态工作流插件，本包的引擎层移植来源；其 examples/sample-project 是本包验收测试集 |
| REF-002 | pi-dynamic-workflows | https://github.com/QuintinShaw/pi-dynamic-workflows.git | thirdparties/pi-dynamic-workflows | 3f0d7e1c1b75536595e5a8bdcd69b5bd615a28ea | MIT | 集成范本：pi 平台接入方式（package manifest、createAgentSession 子会话、pi-tui widget）参考实现 | 2026-11-14 引入。pi 版动态工作流插件，本包的平台适配层参考来源 |
| REF-003 | vercel-workflow | https://github.com/vercel/workflow.git | thirdparties/vercel-workflow | b1f92691b（HEAD 浮动，待固定窗口核定） | Apache-2.0 | 方法论参考：durable execution 工作流编排（hook/step 持久化语义、run 状态管理）；只读研究，集成前再评估 | 2026-11-14 引入。vercel 官方 AI 工作流编排 SDK，为 pi-code-mode 的 M2+ 恢复语义与后台 run 管理提供外部对照 |
| REF-004 | pi-model-router | https://github.com/yeliu84/pi-model-router.git | thirdparties/pi-model-router | 9339ed067e666cedd0f3f44219c0558a0616bc5e | MIT | 方法论参考：pi 平台按回合模型分层路由（high/medium/low tier 启发式、成本预算、fallback 链、virtual model 注册）；只读研究，集成前再评估 | 2026-11-16 引入。与本包 model-tiers 分层解析（agent tier → provider/modelId）直接对标，为 tier 解析策略与意图分类启发式提供外部对照 |
| REF-005 | pi（earendil-works） | https://github.com/earendil-works/pi.git | thirdparties/pi | 4afe78de1e51162c01c946dcf080e6a266685a01 | MIT | 官方上游参考：pi 平台本体（agent core / MCP 扩展 / codemode / tool_search 源码），MCP Tool Integration 计划的对标与上游 issue 反馈依据；只读研究 | 2026-11-18 引入。MCP 集成开发的上游对照（F15 dispose 泄漏、loadMcpConfig 未导出等待反馈项） |
| REF-006 | pi-memory | https://github.com/jayzeng/pi-memory.git | thirdparties/pi-memory | 842727466171c9e50209ed6fe53463a952e5a5f6 | MIT | 方法论参考：pi 平台记忆管理扩展（记忆持久化与索引形态）；只读研究，集成前再评估 | 2026-11-18 引入。与本包 memory/持久化设计（journal、agent 记忆）对照参考 |
| REF-007 | pi-sidebar-tui | https://github.com/bi0h4z4rd88/pi-sidebar-tui.git | thirdparties/pi-sidebar-tui | 38d2a33a3fdbd2f5f24c19d79805a62025ae7d41 | 未发现 LICENSE 文件 | 只读研究，禁止复制任何代码：pi 终端侧边栏 TUI 扩展（session 指标/todo/workspace/已连 MCP server 实时面板），与本项目 TUI widget 层形态对照 | 2026-11-18 引入。与本项目 TUI widget 层（MCP 状态展示方向）形态对照参考 |
| REF-008 | pi-ui-extension | https://github.com/1993yihuan/pi-ui-extension.git | thirdparties/pi-ui-extension | 5ea4acc0f0e5cf8564967c00c3a160439fa9ee0a | MIT | 方法论参考：pi 全屏终端 UI 扩展（会话管理/上下文占用/Tool 与 MCP 活动面板/i18n 组织），与本项目 workflow 状态展示方向对照 | 2026-11-18 引入。其 MCP 活动/上下文占用展示与本包 workflow 观测（Node Inspector/onMcpCall 审计）方向对照 |
| REF-009 | agents（luan） | https://github.com/luan/agents.git | thirdparties/agents | f8eec56fe1c185713322996eadfda7c03d82ebf3 | MIT | 方法论参考：多 harness agent 配置集合；关注子目录 `harnesses/pi/agent`（pi 的 AGENTS.md/SYSTEM.md/settings/keybindings/themes 配置形态），submodule 指向仓库根，使用时引用该子路径 | 2026-11-18 引入。为 pi-code-mode 的 agent 配置组织（AGENTS.md 形态、settings 结构）提供外部对照 |
| REF-010 | pi-sidebar | https://github.com/jrimmer/pi-sidebar.git | thirdparties/pi-sidebar | be97bc66833d119216166b97e6901b8d38df5e03 | BSD-3-Clause | 方法论参考：pi 悬浮右侧边栏扩展（git diff/status 与会话元数据展示），与本项目 workflow/审计状态展示方向对照 | 2026-11-18 引入。与 REF-007/REF-008 同形态赛道，后续 TUI 状态面板选型对照 |
| REF-011 | pi-web（jmfederico） | https://github.com/jmfederico/pi-web.git | thirdparties/pi-web | 9931e1164381d5812c72715cec97fb09fd941859 | MIT | 架构参考（第一优先）：remote-first Pi Web Runtime（Machine/Project/Workspace/Session 层级、浏览器=控制面板而非执行环境、Web/TUI 共存），为 Workflow Dashboard 的 Server/Event 架构选型对照 | 2026-11-18 引入。Workflow Dashboard 调研三仓库源码级对比之一 |
| REF-012 | pi-agent-dashboard | https://github.com/BlackBeltTechnology/pi-agent-dashboard.git | thirdparties/pi-agent-dashboard | f908ec7d3ce275e38419f17b78a1fba0c704443a | MIT | 架构参考（第二优先）：pi 实时 Dashboard（多 session/live chat/terminal/diff/pi-flows 执行/mobile remote），与 TUI 共存形态与本项目 TUI+Web 双入口一致 | 2026-11-18 引入。Workflow Dashboard 调研三仓库源码级对比之一（develop 分支） |
| REF-013 | pi-web（Epsilondelta） | https://github.com/Epsilondelta-ai/pi-web.git | thirdparties/pi-web-epsilondelta | 8b8bf7b2f162617ca1a7823bb4a52a4ac35cac35 | MIT | 技术实现参考：Go Backend + Astro/SSE/AG-UI 兼容 endpoint（session/file/git/terminal realtime），与本项目事件流（onMcpCall/Node Inspector）的 SSE 化方向对照 | 2026-11-18 引入。目录名带后缀避免与 REF-011 同名冲突 |
| REF-014 | pi-web-ui | https://github.com/Watercol/pi-web-ui.git | thirdparties/pi-web-ui | b7af6603b15bd80296a366ded805bcbf60385e35 | MIT | 技术实现参考：Web 页面控制 pi --mode rpc 的最小实现（RPC 通道研究样本） | 2026-11-18 引入。研究「Web 控制 Pi RPC」的最小实现样本 |
| REF-015 | awesome-agent-clients | https://github.com/arach/awesome-agent-clients.git | thirdparties/awesome-agent-clients | 117c8b8ecf2ff0bd4684372a96971abfbf2966d6 | CC0-1.0 | 资料索引：Agent Client/Orchestration Dashboard 清单（Mission Control/Vibe Kanban/T3 Code 等），为 Workflow Dashboard 的编排形态对照提供目录 | 2026-11-18 引入。Mission Control/Vibe Kanban 等编排类项目的入口索引 |
| REF-016 | pi-context-view | https://github.com/dimk90/pi-context-view.git | thirdparties/pi-context-view | 3cded3f7a202239c66e29111db1de013b2bd79e8 | MIT | 方法论参考：pi 上下文占用可视化扩展（base prompt/tools defs/extension injections 的隐藏上下文检视）；只读研究，集成前再评估 | 2026-11-19 引入。上下文用量可视化与隐藏注入检视，与本包 workflow 观测/上下文展示方向对照 |

## Submodule 引入与登记流程

1. 引入：`git submodule add <仓库地址> thirdparties/<项目名>`，克隆后固定到目标 commit。
2. 忽略规则：`.gitignore` 默认不忽略 `thirdparties/`，无需白名单；如某个本地只读目录不入库，单独追加该目录的 ignore 条目。
3. 登记：在本文件表格新增一行，固定 commit 用 `git -C thirdparties/<项目名> rev-parse HEAD` 获取；License 读取仓库内 LICENSE 文件，无 LICENSE 的仓库填「未发现 LICENSE 文件」并将复用策略标为「只读研究，禁止复制任何代码」。
4. 一并提交：`.gitmodules`、submodule gitlink、本文件。
5. 本地只读目录：无 gitlink，其余流程相同（登记、提交清单）；不入库的单独追加 ignore 条目。

## 说明

1. Submodule 只作为源码研究与方法论参考，不代表全部集成进最终产品；集成决策记录在 `dev-docs/research/`。
2. 更新方式：本地目录用重新下载/克隆覆盖；Submodule 用 `git submodule update --remote <path>` 固定新 commit 并更新本表。
3. 复用第三方代码前核对其 License 与版权声明；复用思想则把提炼后的内容写进本仓库自己的文档并标注来源。
