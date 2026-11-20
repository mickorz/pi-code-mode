# extensions 未纳入 tsc 导致宿主 ReferenceError 崩溃

> 记录时间：2026-11-18
> 影响版本：Explorer M0-M6 落地后（commit `fba5617` ~ `e0ec482`）

## 问题现象

在真实 TUI 会话里对 `/workflows` 命令按 **Tab 补全**，pi 宿主直接崩溃：

```
pi exiting due to uncaughtException:
ReferenceError: runManager is not defined
    at Object.getArgumentCompletions (...\extensions\commands\workflows\index.ts:56:55)
```

同一文件里的 `handler` 正常工作——只有补全路径崩。

## 排查过程

1. 打开 `extensions/commands/workflows/index.ts`，`registerWorkflowsCommand(pi, deps)` 内：

   ```ts
   getArgumentCompletions: (prefix) =>
     completeWorkflowsArgs(prefix, { runManager, cwd: process.cwd() })  // ← 裸 runManager
   ```

   `runManager` 不在这个函数作用域（它只在 `deps.runManager` 里）。

2. 为什么单测没发现：`tests/contract/workflows-completions.test.ts` 只测纯函数
   `completeWorkflowsArgs(...)`，从未调用注册进宿主的那个**闭包**。

3. 为什么类型检查没发现：`tsconfig.json` 的 `include` 只有 `src/**/*.ts`，
   `exclude` 里有 `extensions`（因为 `dist` 只发 `src`）。`npm run build` 因此**从不检查 extensions**。
   手动跑一份包含 extensions 的临时 tsconfig，立刻报出：

   ```
   extensions/commands/workflows/index.ts(56,39): error TS18004:
     No value exists in scope for the shorthand property 'runManager'
   ```

   同类还有一处真 bug：`extensions/commands/workflows/navigator/index.ts` 里
   `model.snapshot()` 少传必需的 `bodyRows` 参数（TS2554），滚动钳制会算出 NaN。

## 根因

两件事叠加：

1. **extensions 不在类型检查范围内** → `Cannot find name` / 参数个数这类"必崩"错误可以入库。
2. **测试只覆盖纯函数、不覆盖注册给宿主的闭包** → 装配期的引用错误无人拦截。

宿主的命令/工具回调是"宿主调用"而非"我们自己调用"，这类闭包最容易漏测；
而它一旦抛错，后果不是降级而是**打死整个 pi 进程**（宿主无 try/catch 包住补全）。

## 解决方案

1. 修引用：`runManager` → `deps.runManager`。
2. 修参数：`model.snapshot(bodyRows())`。
3. 补宿主 Component 契约要求的 `invalidate()`（navigator overlay 与 widget 两处）。
4. **把 extensions 纳入类型关卡**（根因修复）：
   - 新增 `tsconfig.extensions.json`（`noEmit`，include `src` + `extensions`）
   - `npm run build` 改为 `tsc -p tsconfig.json && tsc -p tsconfig.extensions.json`
5. 补装配层测试：直接调用注册得到的 `getArgumentCompletions`（见
   `tests/contract/workflows-command.test.ts` 的"命令装配"两条用例）。

## 预防 / 注意事项

- **宿主回调（命令补全 / 命令 handler / 工具 execute / widget render / overlay render）必须至少被测试真实调用一次**，
  不能只测它内部调用的纯函数。
- 新增 `extensions/` 下文件后，`npm run build` 必须仍为绿——它现在同时检查 extensions。
- 见 `dev-docs/guides/分支工作区TUI测试指南.md`：进入 TUI 后**先按一次 Tab 补全**，
  这是最容易暴露装配期错误的最短路径。
- 宿主的补全、render 回调没有自防御包裹：**这些位置的任何异常 = 宿主进程死亡**，
  必要时在回调内部自己 try/catch（render 侧本仓库已有此约定）。
