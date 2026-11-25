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
