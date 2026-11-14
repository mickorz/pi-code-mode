# widget 渲染异常击穿 pi 宿主进程（TUI 一跑 workflow 就整体退出）

**日期**：2026-11-15 · **里程碑**：M4 TUI widget · **严重级**：P0（宿主进程级崩溃）

## 问题现象

- 完整 pi 会话（TUI、加载全部扩展）中调用 `workflow` 工具启动 run（如 `scriptPath=dev-examples/sample-project-acceptance/A-basic/smoke-test.js`），**run 启动后 1-2 秒内整个 pi 宿主进程直接退出**，工具调用返回 `No result provided`，journal 里没有任何该 run 的文件（崩在 journal flush 之前）。
- 同一命令在 headless（`pi -ne -e . --print`）与完整扩展 headless（`pi --print` + `BILI_PI_INLINE=1`）下**完全正常**，3 agent 全 ok、EXIT 0——复现不出来。
- macOS 无 DiagnosticReports、系统日志无进程崩溃记录 → 不是信号/OOM，是**未捕获 JS 异常**导致的进程退出。

## 排查过程

1. journal 无新文件 → 崩在 run 创建/落盘前后最初阶段。
2. grep 引擎 kill/spawn 逻辑：agent 走进程内 SDK 会话（`createAgentSession` + `noExtensions`），不 spawn 子进程、无进程树管理 → 排除"误杀进程"。
3. 完整扩展 headless 复现失败 → 唯一差异是 **TUI**；而 widget 在 headless 被 `ctx.hasUI=false` 守卫跳过 → 锁定 widget 渲染路径。
4. 读 widget render 代码对照 `runManager.list()` 返回类型 → 找到类型错配。

## 根因

`RunManager.list()` 的快照里 **`agents` 是数量（number）**（`src/manager/run-manager.ts:86`，`agents: r.agents.length`），而 widget 渲染把它当数组用：

```ts
const done = r.agents.filter((a) => a.status === "ok").length   // number.filter → TypeError
```

run 创建 → status=running → widget 2s 定时器触发 requestRender → render 在**宿主 TUI 渲染循环内**抛 `TypeError: r.agents.filter is not a function` → 未被任何层捕获 → pi 宿主进程整体退出。

类型为什么没拦住：widget 写在 `extensions/pi-code-mode.ts`，**不经 tsc 构建**（宿主 jiti 直载 TS，只转译不查类型；`tsconfig` 也不含 extensions 目录）——`npm run build` 对 extensions 是盲区。

## 解决方案（commit 6a94a06 前后，见 git log）

`extensions/pi-code-mode.ts` 的 `installTaskWidget`：

1. done 进度改走 `runManager.status(runId)`（全量 `agents: AgentRecord[]`），`list()` 只用来筛 running 与计数。
2. **整个 render 包 try/catch**，异常时 console.error + 返回 `[]`——widget 渲染异常绝不允许打进 TUI 渲染循环（双保险）。

## 预防/注意事项

- **extensions/ 目录无类型关卡**：任何 `npm run build` 拦不住的类型错配（尤其对 src 导出类型的误用）都会直达宿主。给 extensions 加 tsconfig include 或至少 CI `tsc --noEmit` 是后续待办。
- **widget/渲染回调必须自防御**：宿主不隔离 widget 异常，render 内任何 throw = 杀宿主。
- 排查同类问题的高效路径：headless 复现不了 → 先怀疑 TUI-only 路径（widget/命令/notify），再看 journal 是否落盘定位崩溃时点。
- headless 验证完整扩展组合时用 `BILI_PI_INLINE=1` 避免 bili 代理端口轮换干扰当前会话。
