# 第三方参考项目清单（REFERENCES.md）

> 维护规则：所有第三方项目只读，不修改源码；复用代码前必须核对 License；本文件随仓库入库。
> 引入方式分两类：本地只读目录（默认也随仓库入库，重新下载/克隆覆盖更新；需排除的单独在 .gitignore 追加）与 Git Submodule（固定 commit，gitlink 入库）。
> 引入日期：逐条在表格登记时记录。

| ID | 项目 | 仓库 | 本地路径 | 固定 commit | License | 复用策略 | 研究目的 |
|---|---|---|---|---|---|---|---|
| REF-001 | opencode-dynamic-workflows | git@github.com:mickorz/opencode-dynamicworkflows.git | thirdparties/opencode-dynamic-workflows | 7f6e93abb4ff993bbcc4dd8ebb7a66e47b1f9170 | MIT | 功能蓝图：runtime 引擎与 DSL 设计移植到本包（保留版权声明） | 2026-11-14 引入。opencode 版动态工作流插件，本包的引擎层移植来源；其 examples/sample-project 是本包验收测试集 |
| REF-002 | pi-dynamic-workflows | https://github.com/QuintinShaw/pi-dynamic-workflows.git | thirdparties/pi-dynamic-workflows | 3f0d7e1c1b75536595e5a8bdcd69b5bd615a28ea | MIT | 集成范本：pi 平台接入方式（package manifest、createAgentSession 子会话、pi-tui widget）参考实现 | 2026-11-14 引入。pi 版动态工作流插件，本包的平台适配层参考来源 |

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
