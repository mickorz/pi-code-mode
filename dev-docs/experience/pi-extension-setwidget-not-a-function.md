# pi 扩展工厂期调用 pi.setWidget 报 not a function

## 问题现象

`pi -e . --print`（或任何方式加载插件）启动即崩：

```
Error: Failed to load extension ".../extensions/pi-code-mode.ts": Failed to load extension: pi.setWidget is not a function
Hint: Start without extensions using "pi -ne".
```

插件完全无法加载，所有工具（workflow / schedule_*）一起失效。

## 排查过程

1. 查宿主类型声明 `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`：`ExtensionAPI` 上根本没有 `setWidget`；它挂在 `ExtensionContext.ui`（`ExtensionUIContext`）上：

   ```ts
   ctx.ui.setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void
   ctx.ui.setWidget(key, factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined, options?): void
   ```

2. 对照官方 examples：`examples/extensions/widget-placement.ts`、`rpc-demo.ts`、`plan-mode/index.ts` 全部是 `pi.on("session_start", (_e, ctx) => { ctx.ui.setWidget(...) })` 模式。

## 根因

M4 移植 TUI widget 时按直觉写了 `pi.setWidget(key, factory)`（opencode 的注册面习惯）。pi 的 widget 是**会话上下文 API**：扩展工厂函数执行期没有 ctx，必须在事件（`session_start` 每次会话启动/切换/reload 都会触发）里拿 ctx 再注册。

## 解决方案

```ts
pi.on("session_start", (_event, ctx) => {
  if (!ctx.hasUI) return // print/JSON 模式无 UI，必须守卫，否则非交互模式崩
  ctx.ui.setWidget("workflow-tasks", (tui, _theme) => ({
    render,                       // (width: number) => string[]
    dispose: () => clearInterval(timer),
  }))
})
```

修复位置：`extensions/pi-code-mode.ts` `installTaskWidget()`（commit 见本文件同批提交）。

## 预防/注意事项

- 移植宿主 API 前先查宿主 `dist/core/extensions/types.d.ts` 与官方 `examples/extensions/`，不凭 opencode 经验猜 pi 注册面。
- 官方约定：`ctx.mode === "tui"` 守卫终端专属行为、`ctx.hasUI` 守卫交互/RPC 通用交互；widget 属于前者级别，`hasUI` 即够。
- headless 冒烟（`pi -ne -e . --print`）应纳入插件改动后的例行检查——本 bug 单测全绿也发现不了，只有真实宿主加载才暴露。
