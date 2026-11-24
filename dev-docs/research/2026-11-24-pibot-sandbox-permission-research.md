# PiBot 沙盒与权限管理实现调研

> 来源：`thirdparties/PiBot`（REF-023，Apache-2.0，commit 86a7967）
> 调研目的：为 pi-code-mode 引入沙盒与权限管理提供实现蓝本
> 调研日期：2026-11-24

## 一句话总结

PiBot 把安全做成**一个统一闸门（policy 引擎）+ 一个统一出口（sandbox 执行层）+ 一个审批闭环（approval/grant/audit）**：每个工具调用都先过静态分析得出 allow / ask / deny 三态裁决，命令执行强制走 OS 级沙盒（文件系统读写边界 + 网络域名白名单代理），ask 的调用落成审批卡片、用户答复后可"记住"为持久授权（grant），全过程写入只含事实不含内容的审计日志。

类比：这像一座**机场安检 + 登机口 + 黑匣子**的组合——policy 引擎是安检仪（每件行李都过机，X 光片有据可查），sandbox 是隔离候机区（进了候机区只能走允许的通道、访问允许的商店），approval/grant 是登机牌签发系统（第一次要人工盖章，盖过章的路线下次免检），audit 是黑匣子（只记录"谁在几点去了哪个登机口"，不录音谈话内容）。

---

## 1. 总体架构：两条硬约束

PiBot 的 `CLAUDE.md` 把安全写成不可妥协的硬约束：

1. **每个 agent 可调用的工具都必须过 `packages/policy`，没有旁路**（no bypass）。
2. **命令隔离只允许通过 `packages/execution`**（基于 `@anthropic-ai/sandbox-runtime`），其他任何包不得为 agent 命令 spawn 子进程。

配套第三条：审批、命令执行、一切外发动作都写入审计日志；密钥永不进日志 / renderer / pi 配置文件。

分层依赖（L1 execution → L2 capabilities → L3 agent → L4 orchestration → L5 product）由 `tools/dev/domain-boundaries.ts` 在 lint 期强制，policy 作为横切层只依赖 contracts 和 L1。

```
工具调用请求
   |
   v
[packages/policy] 静态策略引擎 ----> allow（附带沙盒参数） / ask（附卡片事实） / deny（附原因码）
   |                                     |
   v ask                                 v allow
[ApprovalService] 审批卡片 --------> 用户答复（allow/deny/remember）
   |                                     |
   v                                     v
[packages/execution] 沙盒执行（SRT：文件边界 + 网络代理 + 进程隔离）
   |
   v
[audit] 事实性审计日志（approval.requested / exec.started / exec.finished / policy.denied / grant.created ...）
```

## 2. 策略引擎（packages/policy）

### 2.1 三态裁决与统一入口

- 决策类型就三个：`"allow" | "ask" | "deny"`（`core/types.ts`）。
- 唯一入口 `createEvaluator()` → `judge()` → `parseInput` → `intrinsicDecision`（内在规则）→ 按类别分发 → `finish()` 汇总裁决。整条评估有 10 秒超时预算（`AbortSignal.timeout(10_000)`）。
- 请求是**分类联合类型**（`PolicyRequest`），覆盖 `run_command`、`read_file/list_dir/write_file`、`web`、`connector`、`send_out`、`computer`、`memory`、`agent_delegation`、`local_network` 等十余类，每类带自己的事实字段（如命令文本、cwd、目标域名、是否后台）。

关键设计：**策略引擎是纯计算 + 注入的文件系统接口**。`EvaluationInput.fs: FileSystem` 由宿主注入（realpath / canonicalize / readScript / listNames），使同一引擎既能在本地 brain 跑，也能在远端 runner 跑（远端没有 readScript 就"继续问"，fail-closed）。

### 2.2 命令静态分析（tree-sitter-bash AST）

policy 包依赖 `tree-sitter-bash` + `web-tree-sitter`，把 shell 命令解析成 AST 后提取：

- `programs / commands`：涉及的程序与管道各段
- `reads / writes`：读写的路径
- `domains / network`：访问的域名、是否有网络
- `readonly`：是否纯只读（配合 `readonly-programs.ts` 只读程序白名单）
- `fileRedirect / inputRedirect / pipedCommands`：重定向与管道结构
- `incomplete`：分析是否完整（有变量展开等看不懂的部分 → 保守 ask）
- `scriptPins`：裁决依据的脚本文件 + SHA-256，**执行前重读比对，变了就拒绝**（`script_changed`）——防 TOCTOU
- `scriptInterpreters`：脚本裁决假定了系统解释器路径，执行前在 PATH 里解析验证，发现可写目录下的同名程序或版本管理器 shim 就拒绝

辅助分析器在 `commands/` 下约 30 个文件：危险命令（`dangerous.ts`）、shell 替换（`shell-substitution.ts`）、sed、git、PowerShell 段、curl 选项、包装器选项等。`dangerous.ts` 之类产出 `risk: "normal" | "danger"`，danger 级别即使 YOLO 开着也必须问。

### 2.3 权限级别（Level）体系

`protocol-base/src/permissions/settings.ts`（zod schema，边界校验）：

- 类别枚举 `Category`：`run_command / connector / computer / read_file / list_dir / write_file / read_ai_config / read_messages / send_out / web / agent_delegation`。
- 每类一个级别：**`"never" | "ask" | "always"`**（`LevelSchema`）。
- 全局默认 + Bot 级覆盖（`BotPermissionOverrides`）+ 组级覆盖；生效规则极简：`override ?? global`（`levels.ts` 全文 5 行）。
- 网络设置独立：`NetworkSettingsSchema { allowAll, domains[]（最多 200，域名正则严格校验） }`。
- settings 用 `z.strictObject`，未知类别直接拒收——持久化数据不会带进不支持的类别。

### 2.4 持久授权（Grants）

用户在审批卡片上选"允许并记住"后落库（`GrantsRepo`），匹配逻辑在 `grants/grants.ts`：

- grant 按 `botId + category + scope.kind` 匹配，`revokedAt !== null` 即失效。
- scope 按类别有不同形状：`send_target`（连 digest 校验，防连接定义被换后旧授权仍生效）、`domain`（站点覆盖子域名：`example.com` 盖住 `www.example.com`，不盖 `evil-example.com`；IP 精确匹配）、`folder` / `workplace` / `programs`（路径包含判断 `containsPath`）、`secret` 等。
- 另有两类非持久授权：`runGrants`（本次 run 内存内有效，run 结束即失效）和 routine 预授权（`grants/routine-preauth.ts`，定时任务场景的人工预批）。

### 2.5 受保护路径与硬边界

`paths/protected-paths.ts` 定义**即使用户逐次批准也写不进去**的系统树：

- macOS：`/System /Library /usr /bin /sbin /etc /private /Applications /dev /cores`（例外：`/private/tmp` 等临时目录）
- Linux：`/usr /bin /sbin /etc /boot /lib* /proc /sys /dev /run /var/lib /snap`
- Windows：`Windows / Program Files / ProgramData` 等
- 凭据目录独立清单：`.ssh .gnupg .aws .config/gcloud .kube .docker` ...

还有**跨 Bot 数据隔离**：`botData: { roots, allowed }`——其他 Bot 的 skills/memory/sessions 所在目录永远不可读，注释里点明原因："一张带'始终允许'的审批卡就会把别的 Bot 的数据永久交出去"。

### 2.6 YOLO 模式（会话级"别问了"）

`core/yolo.ts`：YOLO 开启时，本应 ask 的裁决变成 allow（reason=`yolo`），但有明确豁免清单：

- `risk === "danger"` 保持 ask
- 以用户身份外发（`user_send_confirmation`）、付费图片生成（花钱永不默许）保持 ask
- deny 永远是 deny；YOLO **不产生任何 grant**（`canRemember: false`），不会把临时放行固化为永久授权
- brain 只给聊天 run 设置 yolo，定时任务（routines）永不享受

### 2.7 可解释性（explanation trace）

每个 `PolicyResult` 携带 `explanation: PolicyStep[]`——策略逐步骤的裁决轨迹（哪条内在规则、哪个级别、哪个边界生效），审计里只存步骤 id 数组（`policySteps`，正则约束 `[a-z0-9_]{1,64}`）。UI 和审计都能回答"为什么拦/为什么放"。

## 3. 沙盒执行（packages/execution/src/sandbox）

### 3.1 底座：@anthropic-ai/sandbox-runtime（SRT）

即 Anthropic 开源的 Claude Code 沙盒运行时，提供：

- `SandboxRuntimeConfigSchema`：`filesystem { allowRead / allowWrite / denyRead / denyWrite, allowGitConfig }` + `network { allowedDomains, deniedDomains, strictAllowlist, allowLocalBinding, allowMachLookup, parentProxy }` + `credentials.envVars`（按名拒绝传入）+ `ripgrep` / `seccomp` 辅助路径。
- `SandboxManager.initialize(config, authorize)` + `wrapWithSandbox(command, shell, config)`：把命令包进 OS 级隔离（macOS Seatbelt profile / Linux bubblewrap + seccomp / 内置 HTTP+SOCKS 代理做域名白名单）。

PiBot 在其上补齐了生产级细节：

### 3.2 一命令一宿主进程（解决 SRT 全局单例）

`sandbox-host.ts` 开头注释点明动机：**SRT 的 SandboxManager 是模块级单例，代理按"最近一次安装的全局配置"过滤所有请求——两个命令共用一个 manager 时，后启动的 allowlist 会污染先启动的**（macOS 实测）。所以每个长时命令起一个独立宿主进程：

- stdin 传一行 JSON payload（配置 + 命令），保持打开作为存活信号；fd 3 回报 `prepared/ready/failed/violations`
- 宿主是进程组长（detached spawn），命令留在组内；父进程死 → stdin EOF → 全组 SIGTERM/SIGKILL，**绝不留孤儿沙盒**
- payload 超限直接失败（有 `SANDBOX_PAYLOAD_BYTES` 上限校验）
- 宿主最后存活：先确认组内无残留进程（drain 轮询），再 `SandboxManager.reset()` + 退出

### 3.3 配置生成（sandbox-config.ts，fail-closed 哲学）

`createSandboxConfig().config()` 把策略层的裁决编译成 SRT 配置，处处体现 fail-closed：

- 写根校验：`writeRoot()` 每个可写根都过 `profileRoot()` 校验，任何不合规范的根抛 `outside_workplace`——**deny 时刻意清空 `outsideWrites/outsideWriteRoots`**（`deny.ts`："A refused call opens nothing; execution must never find roots left on a deny"）
- 敏感读边界（`sensitive-paths.ts`）生成 denyRead；命令私有 temp 目录（每个命令只拿到自己的临时文件夹，不共享 OS temp 树——避免扫描到无关受保护目录又跳过它们导致漏报）
- 环境变量按名 deny（`JAVA_TOOL_OPTIONS`、`GIT_CONFIG_COUNT`——这两个都能注入任意命令）
- 可写根内的**符号链接别名扫描**（`verifyCommandAliases`）：readonly bind 保护的是路径名不是 inode，先扫出可写别名再 denyWrite，防硬链接/symlink 绕过
- Git 专项：`gitMetadataWriteDenies`（保护所有 `.git` 元数据路径）、hooks 目录 deny、git config 写入单独授权形态
- macOS `allowMachLookup` 只放行 3 个系统服务（configd/trustd），注释强调"每加一项都需要本地探针验证"
- **沙盒宿主 socket 目录本身加入 denyWrite**："命令不得替换或删除别的 Bot 的沙盒代理 socket"

### 3.4 网络代理与违规归因

- `network-proxy.ts`：SRT 内置代理做域名白名单（strictAllowlist 时未列域名一律拒）；`parentProxy` 支持挂 PiBot 自己的上游代理。
- 本地网络（private network）单独闸门：默认拒绝访问局域网地址，用户卡片批准后按 run 生效（`privateNetwork: { approved: string[] }`），一次批准只开本次 run。
- **违规归因**：代理拒绝只发生在宿主进程的 SRT store 里，输出被管道化时 exit 0 也不会丢——宿主在收尾时从 `SandboxManager.getSandboxViolationStore()` 取出 deny 行，经 fd 3 报给 exec（`reportProxyViolations`），最终进审计的 `sandboxBlockKinds` / violation log。**沙盒拦截本身也是一等观测对象，不是静默失败。**

### 3.5 平台差异的诚实处理

- macOS：Seatbelt（SRT 内置），成熟。
- Linux：bubblewrap + **userns**（`linux-userns.ts`）+ seccomp 辅助（`vendor/seccomp/<arch>/apply-seccomp`，找不到 helper 直接抛 `isolation_unavailable`——fail-closed，不降级为不隔离执行）。
- Windows：SRT 无 OS 隔离 → 策略层特殊处理（`windows-command-approval.ts`、`windows_unisolated` 原因码）：普通命令要求一次性显式同意（"Windows 命令未隔离"卡片），danger 仍然拦。**平台做不到就明说"unsupported"，绝不假装隔离。**（`CLAUDE.md` 硬约束第 4 条）

### 3.6 沙盒外的逃逸通道是显式且受控的

`outsideSandbox` 是 `PolicyRequest` 上的显式字段 + 独立事实（`outside-sandbox.ts`，由 brain 提供、**永不来自模型输入**）；工作区外的写入要逐次审批，审批通过后**只对这一次调用**开放目标路径（或其最近存在的父目录）作为写根。包管理器缓存这类模型声明不了的写入走 `writePaths` 声明通道，且有 `rememberedWritePaths`（按 folder+program 记忆）减少重复打扰。

## 4. 审批闭环（ApprovalService + grants + audit）

`brain/src/core/approvals.ts`（1206 行）是策略裁决与人的连线：

1. **ask → 卡片**：`PolicyResult` 的 facts（命令、读写路径、域名、风险、原因码）渲染成审批卡片，落库（ApprovalsRepo，持久化——重启也不丢）。
2. **等待可暂停**：超时后 run 暂停（pause）而非直接死；用户回来后凭 `approvalCallHash` 恢复。重启恢复时把所有 pending 审批批量 resolve 为 `expired`（actor=system, decision=deny）并写审计。
3. **串行队列**：每个 Bot 的审批按序处理（`serial()`，promise 链），同一 Bot 的多张卡不乱序。
4. **答复 → 决定**：`resolve(id, decision, remember, preauthorize)`。remember=true 时 `createGrantScope(result)` 从策略结果构造 scope 落 GrantsRepo（zod 再校验一次）。
5. **授权可撤销**：`grant.revokedAt`，撤销写审计（`grant.created` / `grant.revoked`）。
6. **全程审计**：`AuditKindSchema` 是约 150 个事件的枚举（approval.requested/resolved、exec.started/finished、policy.denied、file.written、web.fetched、credential.filled、yolo.changed……）。设计原则写在注释里：**"Detail contains facts only"**——路径、域名、次数、时长、原因码可以进；内容、密钥、提示词永不进。`file.read` 只记路径，`web.fetched` 只记 hostname，URL 用 SHA-256 指纹。

## 5. 与 pi-code-mode 现状的对照

| 维度 | PiBot | pi-code-mode 现状 |
|---|---|---|
| 工具调用闸门 | 所有工具过 policy，无旁路 | 无统一闸门 |
| 命令静态分析 | tree-sitter-bash AST（读写/域名/只读/脚本 pin） | 无 |
| 三态裁决 | allow/ask/deny + never/ask/always 级别 + Bot/组覆盖 | 无 |
| 持久授权 | grants 表 + 撤销 + scope 匹配 | 无 |
| OS 沙盒 | SRT（Seatbelt/bubblewrap+seccomp/网络代理），一命令一宿主进程 | 无（Windows/桌面场景也走审批兜底） |
| JS 层沙盒 | —（agent 内核不执行不可信 JS） | workflow VM（node:vm），**仅确定性用途，自述"不是安全沙箱"** |
| 审批闭环 | 卡片落库 + 暂停恢复 + remember grant + 过期清理 | 无（工具直通） |
| 审计 | 150 类事件、只记事实 | journal 有 workflow 执行记录，但无安全审计语义 |

结论：pi-code-mode 的 VM 沙盒与 PiBot 的沙盒**不是同一层东西**——前者防 workflow 脚本的意外非确定性（pi 官方立场：脚本可信），后者防 agent 执行链路的越权与逃逸。引入 PiBot 式方案补的是后者。

## 6. 引入建议（分层取舍）

按收益/成本排序：

1. **P0 — 策略引擎骨架（纯 TS，无平台依赖，最划算）**：
   - 三态决策 + 类别级别（never/ask/always）+ 全局/Bot 覆盖。schema 直接对标 `PermissionLevelsSchema` 的 zod strict 形态。
   - 对 workflow 场景最小类别集：`run_command`、`write_file`、`web`、`mcp_call`（我们的 MCP 桥）、`agent_spawn`（对应 agent_delegation）。
   - 命令分析可先不引 tree-sitter：用"命令文本 + cwd + 声明式 writePaths"的保守模式（incomplete → ask），PiBot 的 `incomplete_analysis` 路径证明这条可行。
   - 审批 UI 走 pi 扩展的卡片/ask 通道，remember 落 `.pi/workflows/permissions.json`（本项目已有 settings 落盘惯例）。

2. **P1 — 受保护路径 + 跨 run/runGrant 语义**：系统目录 deny 清单（照抄 PiBot 清单结构）、单 run 内存授权、审计事实（只记路径/域名/原因码，workflow journal 已有落盘位置）。

3. **P2 — OS 沙盒（可选，成本最高）**：直接依赖 `@anthropic-ai/sandbox-runtime`（Apache/MIT，npm 可装），照抄"一命令一宿主进程"模式（必须，单例污染是实测坑）；macOS/Linux 先行，Windows 明确 unsupported → 全审批兜底。注意 SRT 需要 ripgrep 与（Linux）seccomp helper 的分发，打包成本需评估。
   - 对 pi-code-mode 而言，最需要沙盒的是 workflow 里 agent 产出的命令执行与 coder 角色的验证命令；纯编排（零 agent）flow 不需要。

4. **不引入的部分**：PiBot 的 phone/runner/relay/computer-use 闸门体系（我们无此场景）、150 类审计事件（按需子集）、Bot 间数据隔离（我们单 Bot 语义）。

## 7. 引用时必须复刻的坑位清单（PiBot 用注释换来的教训）

- SRT SandboxManager 是单例 → **必须一命令一进程**，否则 allowlist 串味（macOS 实测）。
- deny 时清空所有待开放的路径根——"被拒的调用什么也不打开"。
- 脚本 pin（SHA-256 重读比对）+ 解释器 PATH 复核——防 TOCTOU 与 shim 劫持。
- 环境变量黑名单（`JAVA_TOOL_OPTIONS`、`GIT_CONFIG_COUNT`）。
- 策略事实与模型输入严格分离：`outsideSandbox`、`commandIsolation` 等"never model input"在注释中反复出现。
- YOLO/自动放行永不写 grant、永不碰 danger、永不碰花钱。
- 平台不支持就显式 unsupported，不假装隔离。
- 沙盒违规要归因上报（violation store → fd 3 → 审计），不做静默拦截。

---

## 参考引用

- PiBot 仓库（本机只读）：`thirdparties/PiBot`
  - 策略引擎：`packages/policy/src/core/types.ts`、`core/evaluate.ts`、`grants/grants.ts`、`paths/protected-paths.ts`、`core/yolo.ts`
  - 权限 schema：`packages/protocol-base/src/permissions/settings.ts`、`permissions/audit.ts`
  - 沙盒执行：`packages/execution/src/sandbox/sandbox-config.ts`、`sandbox-host.ts`、`network-proxy.ts`
  - 审批闭环：`packages/brain/src/core/approvals.ts`
  - 安全硬约束：`PiBot/CLAUDE.md`（Hard constraints 第 6、8 条）
- Anthropic Sandbox Runtime：https://github.com/anthropics/sandbox-runtime （npm: `@anthropic-ai/sandbox-runtime`，PiBot 固定 0.0.81）
- pi agent kernel：https://github.com/earendil-works/pi
- 登记清单：`thirdparties/REFERENCES.md` REF-023
