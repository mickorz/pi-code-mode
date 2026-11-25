# M2-W2-Workspace Registry MVP-执行报告

> 阶段：M2-W2（Workspace Isolation MVP）
> 日期：2026-11-25
> 前置：M2-W0b（MXC 可行性）、M2-W0c（安全收尾）
> 结果：**MXC 实测 14/14 PASS；contract 单测 6/6；全量 contract 291/0、engine 222/0**

## 1. 解决什么问题

M2-W0c 证明了 MXC 能隔离两个工作区，但**隔离规则依赖调用者主动传 `denyWorkspaces`**。
这意味着能力在 Sandbox 层，权限决策却散落在每个 Agent/Workflow/Tool 里——迟早遗漏。

本阶段补上最后一层，固定职责边界：

```
Agent    提出执行请求（不知道其他工作区存在）
Runtime  决定权限（WorkspaceRegistry，唯一权威）
Sandbox  强制执行权限（MXC + SRT）
```

## 2. 交付物

| 文件 | 职责 |
|---|---|
| `packages/execution/src/workspace/path-normalize.ts` | 路径规范化：realPath（交沙盒）与 canonicalKey（仅比较）分离；Windows 小写化；不存在的路径向上找最近存在祖先 realpath 后再拼回 |
| `packages/execution/src/workspace/registry.ts` | `WorkspaceRegistry`：register / acquire / release / unregister / getAll / findByPath / getIsolationPolicy |
| `packages/execution/src/sandbox/srt-executor.ts` | 注入注册表：**存在注册表时忽略调用方传入的 deny 列表**；未登记目录或策略解析失败 → `blocked`（fail-closed） |
| `tests/contract/workspace-registry.test.ts` | 6 个纯逻辑用例（任何平台可跑） |
| `dev-examples/mxc-probe/m2-w2-check.ts` | 14 项 MXC 真实环境验证 |

## 3. 关键设计决策

### 3.1 注册表保留身份，不因 owner 归零而删除

- `status: active | inactive` + `owners: string[]`（引用计数）
- 最后一个 owner 释放 → `status = inactive`，**条目保留**
- 只有显式 `unregister`（且 owners 为空）才真正移除；有 owner 时注销被拒

理由（W2-04）：B 工作区关闭后若立即从注册表删除，A 就能重新读 B。保留身份才能让 deny 持续生效。

**边界诚实声明**：这只保护"已登记为 pi-code-mode 工作区"的目录。未登记的普通宿主目录不受此策略保护，不能宣称实现了整个用户目录的完全隔离。

### 3.2 deny 集合排除祖先工作区

若当前工作区 A 嵌套在已登记的 O 内，deny O 会连带 deny A 自己。策略：排除祖先并在 `excluded` 里记录 `ancestor_of_current`（可观测，不进模型输入）。子工作区仍单独 deny（更严格，无异义）。

### 3.3 路径规范化：realPath 与 canonicalKey 分离

| 概念 | 用途 | 处理 |
|---|---|---|
| `realPath` | 交给 MXC 作为实际路径 | resolve + realpath（消解 junction/symlink），**保持原始大小写** |
| `canonicalKey` | 仅用于比较 | Windows 小写化 + 分隔符统一 + 去尾分隔符 |

混用的后果：把全小写路径喂给 MXC 在大小写敏感语义下匹配不到真实目录。

**不存在的路径**（如嵌套子目录、新建工作区）不能直接 realpath：向上找最近存在的祖先解 realpath 再拼回尾段。**这是本轮单测抓到的真 bug**——只用 `path.resolve` 会让 Windows 下同一目录的短名/长名产生不同比较键，导致嵌套路径漏判为"不属于该工作区"。

### 3.4 fail-closed 三处

1. 未登记目录 + 注册表存在 → `blocked`（不执行）
2. 策略解析失败（`not_registered` / `path_invalid`）→ `blocked`
3. 路径解析遇非 ENOENT 错误（权限等）→ 抛错，不静默降级为空 deny

## 4. 验证结果

### 4.1 MXC 真实环境（Windows，Node 26.11.1）：14/14 PASS

| 编号 | 内容 | 结果 |
|---|---|---|
| W2-01 | 三工作区注册 + findByPath | PASS |
| W2-02 | A 读 B → 拒绝（Runtime 自动注入，调用方未传任何 deny） | PASS |
| W2-03 | A 写 A → 允许 | PASS |
| W2-04 | B 关闭（inactive）后 A 读 B → 仍拒绝 | PASS |
| W2-05 | 多 Run 同工作区不提前注销；有 owner 时注销被拒 | PASS |
| W2-06 | 并行 Sandbox 无权限交叉 | PASS |
| S1a | 大小写/尾分隔符/相对片段 → 同一比较键 | PASS |
| S1b | 小写路径访问 B 仍被拒 | PASS |
| S1c | 嵌套工作区 N 的 deny 含 B 与 C | PASS |
| S1d | 从嵌套工作区 N 读 B 被拒 | PASS |
| S1e | **经由 junction 读 B 被拒** | PASS |
| S2a | 未登记目录拒绝执行 | PASS |
| S2b | 非法路径抛错 | PASS |
| S2c | 有 owner 时注销被拒 | PASS |

### 4.2 contract 单测：6/6（任何平台可跑）

注册幂等与嵌套归属、deny 含 inactive、引用计数、路径归一、祖先排除、fail-closed。

### 4.3 全量回归

build 零错误；contract **291/0**（+6）；engine **222/0**。

## 5. 遗留

| 项 | 说明 |
|---|---|
| 注册表持久化 | MVP 为进程内内存态；重启后需重新登记（组件尚未接入 RunManager） |
| 接入 RunManager / 插件入口 | 当前 `createCommandExecutor` 尚未自动挂注册表；需在 M2 后续把工作区生命周期与 Run 生命周期绑定 |
| Cocos 真实构建链 | 仍未验证（M2-W3） |
| Windows Sandbox 正式验收 | 仍为 CONDITIONAL-GO，未放行 |

---

## 6. M2-W2b：接线到 Runtime（2026-11-25 续）

### 6.1 解决的问题

M2-W2 只证明了"注册表 → executor → MXC"链路正确，但注册表还是进程内孤立对象，无人填充。
本阶段把它接到插件入口与 Adapter 生命周期。

### 6.2 交付

| 文件 | 改动 |
|---|---|
| `packages/execution/src/workspace/ensure.ts`（新） | `ensureWorkspace(registry, path)` 自动登记；`workspaceIdForKey` 由比较键**确定性派生**（`ws-<sha256前12>`，不含随机数，天然幂等） |
| `packages/execution/src/workspace/registry.ts` | `getAll()` / `register()` / `acquire()` / `release()` 返回**快照**（浅拷贝），外部拿到引用改字段不影响内部状态，必须经 acquire/release 才有效 |
| `packages/execution/src/command/factory.ts` | `createCommandExecutor({ workspaceRegistry })` 透传 |
| `packages/adapter/src/pi-agent-adapter.ts` | 新增 `workspaceRegistry` 选项；`execute()` 内 `ensureWorkspace` + `acquire(executionId)`，`finally` 中 `release`。登记失败 → 返回 `fail("session", ...)`（fail-closed，不在无隔离策略下执行） |
| `apps/plugin/extensions/pi-code-mode.ts` | 模块级 `WorkspaceRegistry` 单例（与 extension 同寿）；加载时登记 `process.cwd()`；同时注入 `createCommandExecutor` 与 `PiAgentAdapter` |

### 6.3 端到端验证（真实 MXC）：7/7 PASS

| 编号 | 内容 | 结果 |
|---|---|---|
| E1 | `ensureWorkspace` 自动登记 + id 确定性（大小写变体得到同一 id） | PASS |
| E2 | acquire → active；release → inactive 但条目保留 | PASS |
| E3 | A 读 B 被拒（**调用方未传任何 deny，Runtime 自动注入**） | PASS |
| E3b | 对照组：B 读自己的文件允许（不是一刀切拒绝） | PASS |
| E4 | 未登记目录 fail-closed 拒绝 | PASS |
| E5 | 多 execution 并发同工作区：引用计数正确、无提前注销 | PASS |
| E6 | **调用方传 `denyWorkspaces: []` 试图清空隔离 → 被忽略，A 仍读不到 B** | PASS |

E6 是接线层的核心安全断言：权限决策权在 Runtime，Agent/脚本无法自行解除隔离。

### 6.4 本轮抓到的问题（都在测试侧/设计侧，非安全缺陷）

1. **测试对象引用陷阱**：`getAll()` 返回的条目是活引用，`release()` 后原先取到的 `during` 会跟着变成 `inactive`，断言读到最终态。
   - 测试修正：断言前快照值。
   - 设计修正：`getAll()` 等改为返回浅拷贝——顺带消除"外部直接改 `entry.status` 绕过 acquire"的隐患。
2. **不存在的嵌套路径**（M2-W2 阶段修复）：只用 `path.resolve` 会让 Windows 短名/长名产生不同比较键，嵌套路径漏判；改为向上找最近存在祖先 realpath 再拼回尾段。

### 6.5 全量回归

- build 零错误
- contract **291/0**
- engine **222/0**
- 插件真实加载冒烟：`pi -ne -e . -p "只回复 ok"` → `ok`（注册表单例装配无异常）

### 6.6 遗留（诚实边界）

| 项 | 说明 |
|---|---|
| 注册表不持久化 | 进程退出后丢失；重启后由插件加载时重新登记当前项目。跨进程/跨会话的工作区身份未保留——若要求"重启后仍 deny 上次登记过的其他项目"，需落盘（`~/.pi/...` 或项目 `.pi/`） |
| 仅登记执行过的目录 | `ensureWorkspace` 只在 Adapter 执行时触发。未被 pi-code-mode 打开过的项目目录不在保护范围 |
| 未登记目录 = 拒绝执行 | 这是当前的 fail-closed 选择；若希望"未登记也可执行但无跨项目隔离"，需显式放宽（不建议） |
| Cocos 真实构建链 | 仍未验证（M2-W3） |
| Windows Sandbox 正式验收 | 仍为 CONDITIONAL-GO，未放行 |
