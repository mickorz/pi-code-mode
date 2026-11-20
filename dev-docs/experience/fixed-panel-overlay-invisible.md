# 右侧固定面板不可见：非法 overlay 锚点 + 无头渲染无数据（双层 bug 复盘）

> 记录时间：2026-11-20
> 关联：`dev-docs/design/2026-11-19-explorer-fixed-panel-可行性分析.md`、`dev-docs/todos/explorer-交互对齐opencode.md`
> 现象：Explorer 右侧固定面板挂载成功（render 每帧被调、返回正常行集），但屏幕上始终看不到。

## 问题现象

1. 固定面板开启后，诊断日志显示 `render` 正常被调、`fixedPanelLines` 输出 5 行，但终端右侧无任何绘制
2. 用户实测「全屏模式能看到一行，非全屏看不到」
3. Ctrl+B 的 overlay（同 API 不同参数）显示正常——排除宿主 overlay 机制整体失效

## 根因（两个独立 bug 叠加）

### Bug 1：非法 overlay 锚点 → NaN 定位 → 零绘制（主因，显示层）

初版默认锚点写成 **`right-top`**——pi-tui 的 `OverlayAnchor` 枚举**没有这个值**（合法：`top-right` /
`right-center` 等 9 个）。`resolveOverlayLayout` 的 switch 对未知锚点返回 `undefined`，row/col 变 NaN，
合成循环 `idx >= 0` 对 NaN 恒 false → **每帧 render 都执行，但一行都没画到屏幕上**。

类型系统没拦住的原因：`ctx.ui` 在扩展侧是 any（`ctx.ui as any` 调 custom），anchor 字符串字面量
不经过任何类型检查——**非法枚举值静默失败，无报错无日志**。

修复（ea5cce5）：默认锚点改 `top-right`；旧配置里的 `right-top` 读取时自动归位（用户无需改文件）；
契约测试锁死映射。

### Bug 2：无头渲染入口没有数据链（主因，数据层）

`ExplorerController.ensureTree(runId)` 只在 `open()`（Ctrl+B 打开 overlay）和 `selectRun()` 时调用；
`onRuntimeEvent` 对 `activeRunId` 未定的 controller **丢弃全部事件**。固定面板是不经过 `open()`
直接 `view()` 的无头渲染入口 → 树模型永远空（诊断日志实锤：`runs=running` 但 `rows=0`）。

修复（765bfa6）：`view()` 作为渲染唯一入口，自动选默认 run（在途优先）并 `ensureTree`（幂等，
快照重建）；契约测试 `explorer-headless-view.test.ts` 锁死。

## 排查过程与教训

1. **日志只能证明「渲染函数在工作」，不能证明「画到了屏幕上」**——render 被调 ≠ 绘制发生。
   两者之间隔着宿主的 overlay 合成（定位计算 → 行合成 → diff 输出），每一步都可能静默失败。
2. **用户口径的「全屏/非全屏」先别急着映射到技术概念**——本次最后靠截图 + 源码重审（而非继续加日志）
   才锁定：非法锚点的 NaN 定位。日志已证明渲染正常后，应立即转向审查「渲染之后」的链路。
3. **any 类型调宿主 API 时，枚举值失去编译期保护**——锚点/对齐/方向这类枚举字符串，
   优先从宿主导出的类型/常量取值，或至少在代码注释里标注合法值清单。
4. **`/reload` 会造成「代码版本 vs 运行时状态」的错位判断**——排查期间多次提交修复，
   用户 reload 的版本与最新修复不同步，导致一度误判「修复无效」。每次让用户 reload 前先明确
   本次 reload 应包含哪个 commit 的修复。
5. 诊断日志写 tmpdir + 时间戳追加，是运行时数据链路排查的有效手段（本次靠它区分了
   「挂载失败 / 数据为空 / 渲染正常但不可见」三种假设）——但它只能覆盖「渲染函数之前」，
   「之后」的合成绘制要靠读宿主渲染源码。

## 预防

- overlay/组件定位参数使用 pi-tui 合法枚举值，写死前对照 `OverlayAnchor` 类型定义
- 无头渲染入口（不经 open 的 view 消费方）必须保证数据链自足——view() 内自动 ensureTree 已是
  通用修复，同类「按需初始化」的控制器方法注意无头调用方
- 宿主 API 经 any 调用时，新增枚举参数先查宿主 .d.ts 的字面量联合类型
