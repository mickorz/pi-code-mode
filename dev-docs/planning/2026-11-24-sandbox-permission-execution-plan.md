# 沙盒与权限管理执行文档

> 状态：待执行（M0 未启动）
> 依据调研：`dev-docs/research/2026-11-24-pibot-sandbox-permission-research.md`（PiBot 实现调研）
> 创建日期：2026-11-24
> 目标仓库路径：本仓库（pi-code-mode）

## 1. 背景与问题

pi-code-mode 的 workflow 会 fan-out 子代理执行实施与验证命令（coder/fixer 角色），但当前**没有任何权限闸门与执行隔离**：

- 子代理的命令执行发生在 pi 子会话的 bash 工具里，模型生成的命令以宿主用户全权限运行；
- workflow VM 只防脚本非确定性（`packages/engine/src/runtime/vm.ts` 自述"vm 不是安全沙箱"），不是安全边界；
- 无统一策略裁决、无审批卡片、无持久授权、无安全审计。

PiBot（REF-023）验证了成熟做法：统一策略引擎 + OS 级沙盒 + 审批闭环。本文档把它落地为本仓库的执行计划。

**类比**：本次建设相当于给 workflow 的每条命令加一套"机场安检系统"——策略引擎是安检仪（每件行李都过机扫描，X 光片可查），沙盒是隔离候机区（进了候机区只能走指定通道），审批与授权是登机牌签发（首次人工盖章，盖过章的路线免检并随时可吊销），审计是黑匣子（只记录"谁几点过了哪个口"，不录音谈话内容）。

## 2. 关键前提（已核实）

| 事实 | 出处 | 对方案的影响 |
|---|---|---|
| pi 扩展可挂 `tool_call` 处理器，**可 mutate input 或 block execution**，handler 出错也 block（fail-safe） | pi docs/extensions.md L106、L263 | 权限闸门的官方接入点，无需 fork pi |
| pi 无内置沙盒，官方隔离 = Docker / Docker Sandboxes / OpenShell / Gondolin（工具级 micro-VM） | pi docs/security.md、containerization.md | OS 沙盒可优先复用官方容器方案，SRT 作进程级补充 |
| pi-code-mode 自身不 spawn 命令，命令执行在 `PiAgentAdapter`（createAgentSession）子会话的 bash 工具里 | packages/adapter/src/pi-agent-adapter.ts | 拦截点必须在子会话也生效（M0 验证项） |
| 落盘惯例 `.pi/workflows/`（model-tiers.json / journal / register.json） | 本仓库 .pi/workflows/ | 权限配置与 grant 沿用此目录 |
| 命令注册惯例 extensions/commands/ 目录形态 + 架构守卫测试 | CLAUDE.md 开发规范、tests/contract/commands-structure.test.ts | 新命令必须按规范接入，先跑 test:contract |
| 任何大模型调用必须走 model-tiers 档位 | CLAUDE.md 强制规范 | 本方案零模型调用（纯规则引擎），不涉及档位 |

## 3. 总体架构

```
pi 宿主（含本扩展）
  |
  | tool_call 事件（bash / write / edit / mcp 等全部工具）
  v
[权限引擎 packages/policy-lite]
  1. 归类：请求映射到类别（run_command / write_file / web / mcp_call / agent_spawn）
  2. 裁决：级别 never ask always + 受保护路径 + grant 匹配 -> allow / ask / deny
  3. 命令静态分析（保守起步：命令文本 + cwd + 声明 writePaths；看不懂 = ask）
  |
  |-- allow --> 放行（附注记，进审计）
  |-- deny  --> 直接返回 block（原因码进审计）
  |-- ask   --> 审批卡片（pi 扩展 UI 通道）
                  用户答复 allow / deny / remember
                  remember -> grant 落盘 .pi/workflows/permissions.json
  v
[沙盒执行通道 packages/sandbox-exec]（M3，可选启用）
  对标记 needsIsolation 的命令：一命令一宿主进程（SRT 包裹）
  文件边界（allowWrite 限工作区）+ 网络域名白名单（SRT 代理）
  |
  v
[审计] journal 事件扩展（事实 only：路径 域名 原因码 时长，永不记内容）
```

### 3.1 与 PiBot 方案的取舍

| PiBot 原设计 | 本方案 | 理由 |
|---|---|---|
| tree-sitter-bash AST 全量静态分析 | M2 保守版起步（文本级），M4 再评估 AST | 工作区命令大多是明文；AST 是增强不是前提，incomplete 一律 ask 已是安全默认 |
| SRT 沙盒（Seatbelt / bubblewrap + seccomp / 网络代理） | M3 引入，但先支持 pi 官方容器路线作为宿主级隔离 | Gondolin/Docker 零代码成本；SRT 需分发 ripgrep 与 seccomp helper，打包成本高，按需再上 |
| 150 类审计事件 | 按 workflow 场景取 6 至 8 类子集 | 我们无 phone/runner/browser 场景 |
| Grants 表（SQLite） | permissions.json 落盘（沿用 .pi/workflows 惯例） | 无服务端，量小（上限 200 条），避免引入 sqlite 依赖 |
| 一命令一宿主进程 | 同款复刻（SRT 单例坑，PiBot 实测注释确认） | 必须照抄，不可省略 |
| Windows 无 OS 隔离 | 显式 unsupported，全审批兜底 | PiBot 同款诚实处理 |

## 4. 里程碑拆解

### M0 验证与奠基（预计 0.5 天）

目标：确认拦截点在子会话生效，冻结接口设计。

- [ ] **验证子会话 tool_call 可达**：写最小扩展试验（dev-examples/policy-probe/），在 tool_call handler 打日志，经 PiAgentAdapter 跑一个会执行 bash 的子代理，确认事件到达。若不可达，则拦截点改为 PiAgentAdapter 内部对子会话注入 policy（方案 B，接口不变）。
- [ ] **确认 pi 权限扩展现状**：检查 pi 是否已有官方/社区 permission 扩展可复用（docs/packages.md、examples），避免重复造轮子。
- [ ] **接口冻结**：新建 `packages/policy-lite/src/types.ts`，定义 `Decision = "allow" | "ask" | "deny"`、`Category`、`Level`、`PolicyRequest`、`PolicyResult`（含 reason 码、facts、grantScope）、`Grant`、`GrantScope`。zod strict schema，对标 PiBot `protocol-base/src/permissions/settings.ts` 形态。
- [ ] 类别最小集冻结：`run_command`、`write_file`、`web_fetch`、`mcp_call`、`agent_spawn`。

验收：probe 结论写入本文档 M0 一节；types.ts 有 contract 测试。

### M1 权限引擎骨架（预计 2 天）

目标：每个工具调用过闸门，三态裁决 + 审批卡 + grant 持久化。

- [ ] `packages/policy-lite/`：`levels.ts`（override ?? global，5 行同款）、`evaluate.ts`（裁决主流程，10 秒超时预算）、`protected-paths.ts`（系统目录 + 凭据目录 deny 清单，抄 PiBot 三平台清单）、`grants.ts`（grant 匹配 + 撤销）、`config.ts`（permissions.json 读写，zod 校验，未知字段拒收）
- [ ] 默认级别：`run_command=ask`、`write_file=ask`、`web_fetch=always`、`mcp_call=ask`、`agent_spawn=always`（保守默认，用户可改）
- [ ] 扩展接入：`apps/plugin/extensions/policy/`（新目录，主入口只装配），注册 `pi.on("tool_call", ...)` 统一闸门；按工具名映射类别，unknown 工具一律 ask
- [ ] 审批卡：走 pi 扩展 UI（ctx.ui），卡片展示命令文本、cwd、读写路径、原因码；答复 allow / deny / remember
- [ ] 命令注册：`extensions/commands/permissions/`（index.ts 路由 + 子命令 `show` / `set` / `grant list` / `grant revoke`），按规范先跑 `npm run test:contract`
- [ ] deny 时清空所有附带开放路径（PiBot deny.ts 同款语义）

验收：
- `pi -ne -e <repo> -p` 端到端：子代理执行 `rm -rf /` 类命令被 deny；执行普通 `ls` 按 always 放行；ask 命令出卡，remember 后第二次免问
- permissions.json 格式有 contract 测试；grant 撤销立即生效

### M2 命令静态分析（预计 1.5 天）

目标：命令裁决从"全问"进化到"有依据地问"。

- [ ] `packages/policy-lite/src/analyze/`：`programs.ts`（只读程序白名单：ls cat grep rg git status 等，对标 PiBot readonly-programs）、`redirects.ts`（输出重定向识别）、`dangerous.ts`（危险命令清单：rm -rf、dd、mkfs、chmod 777 /、curl 管道 sh 等，产出 risk: danger）
- [ ] 分析产物：`{ programs, reads, writes, domains, network, readonly, incomplete }`；`incomplete=true`（管道、变量展开、反引号、多段组合）一律 ask，不猜
- [ ] danger 级命令：任何级别都 ask（never 则 deny），YOLO 也不放行
- [ ] contract 测试：危险命令、只读命令、incomplete 命令各一组用例（无模型，纯函数）

验收：`git status` 类命令在 run_command=always 时自动放行；`curl ... | sh` 永远出卡。

### M3 沙盒执行通道（预计 3 天，可选启用，默认关）

目标：标记需要隔离的命令进 OS 级沙盒执行。

- [ ] 前置决策（需用户确认）：优先 pi 官方 Gondolin/Docker 路线（零代码，配文档）还是 SRT 进程级（本插件代码）。默认建议：先文档化官方容器路线（M3a），SRT 通道（M3b）按需求启动。
- [ ] M3b 实现：`packages/sandbox-exec/`，`sandbox-config.ts`（写根校验 + 敏感读边界 + 环境变量黑名单 JAVA_TOOL_OPTIONS GIT_CONFIG_COUNT）、`sandbox-host.ts`（**一命令一宿主进程**，stdin 一行 JSON payload 保活，fd 3 回报 prepared ready failed violations，父死全组杀，照抄 PiBot）、`violations.ts`（deny 归因上报）
- [ ] 平台边界：macOS Linux 启用；Windows 返回 `isolation_unavailable`，命令降级走 ask 兜底（显式 unsupported，不假装隔离）
- [ ] fail-closed：依赖缺失（ripgrep、seccomp helper）抛错拒绝执行，不降级为不隔离运行
- [ ] 级别联动：`run_command=always` 且沙盒可用且分析完整时，命令可自动放行进沙盒（PiBot sandboxed_command 同款）；沙盒不可用则回 ask

验收：macOS/Linux 上沙盒内命令读工作区外文件被 block 且归因可见；沙盒内网络默认拒绝；杀父进程无孤儿残留。

### M4 审计与收尾（预计 1 天）

- [ ] journal 事件扩展：`policy.denied`、`approval.requested`、`approval.resolved`、`grant.created`、`grant.revoked`、`exec.sandboxed`，只记事实（工具名、类别、路径、域名、原因码、时长）
- [ ] explorer/workflows 面板补权限状态展示（隔离可用性、当前级别、活跃 grant 数）
- [ ] 文档：README 加"权限与沙盒"章节（读者向 docs/），本执行文档更新完成状态并归档 planning/completed/
- [ ] 回填 CLAUDE.md：新增调用点规范（如后续引入 AI 辅助分析，须走 model-tiers 档位并问用户）

## 5. 依赖与风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| 子会话 tool_call 不可达（M0 假设失败） | 中 | 方案 B：PiAgentAdapter 对子会话注入 policy 配置或切换拦截层，接口已冻结不受影响 |
| 审批卡阻塞后台 run / schedule 任务 | 高 | 定时任务（routines 语义）永不享受 YOLO 式自动放行；超时默认 deny 并落审计，不无限等待 |
| ask 卡片在 print 模式无 UI | 高（已知） | print 模式下 ask 一律按 deny 处理并提示用交互会话；与 pi -p 自测规范对齐 |
| SRT 依赖分发（ripgrep、seccomp helper） | 中 | M3b 启动前先做打包验证；不可分发则整段降级为官方容器路线 |
| grant 文件被并发写坏 | 低 | 单写者约定（扩展进程内串行），写入走临时文件 + rename 原子替换 |
| 性能：每命令过闸门 | 低 | 纯同步规则匹配 + 白名单查询，微秒级；无模型调用 |

## 6. 纪律对齐（本仓库强制规范）

- M1 新命令按 extensions/commands 目录形态开发，主入口只装配；完成后跑 `npm run test:contract`（架构守卫）。
- M3 涉及 src 修改，每个里程碑完成后先 `npm run build`（类型关卡）再测试。
- 每个里程碑交付前用 `pi -ne -e <repo> -p` 端到端自测（注意 Git Bash 加 `MSYS_NO_PATHCONV=1`），看产物与状态，不看 print 模式 UI 输出。
- 里程碑完成同步更新 `dev-docs/progress/执行进度.md` 并在 `dev-docs/progress-result/` 建独立阶段报告。
- 本方案零大模型调用；若 M4 后引入 AI 辅助风险分析，先 ask_user_question 确认档位再实现。

## 7. 执行记录（滚动更新）

| 日期 | 里程碑 | 状态 | 备注 |
|---|---|---|---|
| 2026-11-24 | 文档创建 | done | 依据 PiBot 调研与 pi docs 核实 |
| （待填） | M0 | pending | |

---

## 参考引用

- PiBot 实现调研（本仓库）：`dev-docs/research/2026-11-24-pibot-sandbox-permission-research.md`
- PiBot 源码（thirdparties/PiBot，只读）：packages/policy、packages/execution/src/sandbox、packages/brain/src/core/approvals.ts、packages/protocol-base/src/permissions
- pi 扩展 API（tool_call 拦截）：pi docs/extensions.md（宿主安装目录 @earendil-works/pi-coding-agent/docs/extensions.md）
- pi 安全模型：pi docs/security.md；隔离方案：pi docs/containerization.md
- Anthropic Sandbox Runtime：https://github.com/anthropics/sandbox-runtime
- 本仓库规范：CLAUDE.md（开发流程、命令开发规范、model-tiers 强制、自测纪律）
- 登记清单：thirdparties/REFERENCES.md（REF-023 PiBot）
