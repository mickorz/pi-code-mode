# 扩展常驻 timer 不 unref 阻塞 pi --print 退出（附：嵌套 pi headless 卡 stdin）

## 问题现象

1. `pi -ne -e . --print "..."`：模型已输出最终回答（stdout 有内容），但进程 **180s 不退出**，只能 SIGKILL。
2.（前置坑）最初连输出都没有就卡死：从本仓库 bash 里 spawn 嵌套 `pi --print` 完全无响应。

## 排查过程

- 坑 2：对照成功/失败用例发现差异在 stdin——pi print 模式无 TTY 时仍会读 stdin，spawn 不显式关 stdin 就永久等待。`stdio: ['ignore','pipe','pipe']` 后正常。
- 坑 1：stdin 修复后工具调用与输出都正常但不退出 → 事件循环被常驻 timer 挂住。grep `src/` 中所有 `setInterval/setTimeout`：`src/engine/schedule/runtime.ts` 的调度循环 `setInterval(tick, 30s)` 无 unref（run timeout 的 `setTimeout` 同样）。

## 根因

- pi `--print` 输出完回答后**等事件循环排空**再退出；扩展注册的常驻 interval 不 unref 就永远排不空。
- widget 里 2s `requestRender` timer 当时已写了 `unref?.()`（正确示范），schedule 引擎漏了。

## 解决方案

```ts
// src/engine/schedule/runtime.ts start()
this.timer = setInterval(() => void this.tick(), this.intervalMs)
this.timer.unref?.()   // 不阻塞宿主退出；进程存活期照常 tick
// run timeout 的 timeoutTimer 同理 unref
```

验证：修复后 `pi -ne -e . --print`（含一次真实 workflow 工具调用）9.9s 干净 EXIT 0；后续 smoke-test.js 全流程 33.6s EXIT 0。

## 预防/注意事项

- 扩展内**所有**常驻 interval/长 setTimeout 一律 `unref?.()`；进程存活时 unref 不影响触发，只解除退出阻塞。
- 嵌套跑 headless pi：`spawn('pi', [...], { stdio: ['ignore','pipe','pipe'] })`，必配看门狗 PID（CLAUDE.md 联调约定）。
- headless 冒烟的判定标准不只是"输出正确"，还包括**进程正常退出**。
