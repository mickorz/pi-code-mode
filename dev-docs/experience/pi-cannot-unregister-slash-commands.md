# 系统限制：pi 无法注销/替换已注册的斜杠命令（需 /reload 或重启会话）

> 类型：宿主（pi-coding-agent）限制，非本插件缺陷
> 记录日期：2026-11-20
> 关联功能：workflow 顶层斜杠命令直跑（`/<workflowId>`）

## 问题现象

`/workflows unregister smoke_test` 提示已注销成功、脚本已从 `.pi/workflows/register.json` 移除，
但当前会话里 `/smoke_test` 仍出现在斜杠补全中、仍可被回车执行（实际只会提示「已注销」而不跑 workflow）。
重启会话或 `/reload` 后才从补全列表消失。

## 根因

pi 的扩展命令注册表只支持「写入」，没有注销 API：

- 注册：`dist/core/extensions/loader.js` → `registerCommand(name, options)` 只执行
  `extension.commands.set(name, {...})`；后续同名注册是覆盖，**没有 delete/unregister**。
- 消费：`ExtensionRunner.getRegisteredCommands()` 遍历扩展的 `commands` Map 生成补全与分发列表，
  因此命令一旦注册，在本轮扩展加载生命周期内无法消失。
- 重载：`AgentSession.reload()`（`dist/core/agent-session.js`）先 `oldRunner.invalidate()`，
  再 `resourceLoader.reload()` + `_buildRuntime()` 重建 `ExtensionRunner` 和扩展实例，
  旧的 `commands` Map 随扩展对象丢弃 → 命令表被整体重建，残留命令随之消失。
  之后会以 `reason: "reload"` 触发 `session_start`，插件在此重新按当前注册表注册。

结论：命令表的生命周期 = 扩展加载生命周期。要让它消失只能重建扩展实例，即 `/reload` 或重启 pi。

## 影响与本插件的应对

| 场景 | 行为 |
|---|---|
| unregister 后当前会话输入残留 `/<id>` | handler **调用时重查** `.pi/workflows/register.json`：`loadManifest != null && loadRegistry().has(id)` 不成立 → 只 `ui.notify` 警告，绝不调用执行链（`makeDeps` 零调用，不起 run） |
| `/workflows run <id>` | 走工具执行链，注册表读取时即报不可读/未注册，行为正确 |
| 补全列表 | 残留到 `/reload` 或重启；无法在会话内移除 |
| 同一会话内新 register 的 workflow | 不会立刻获得顶层命令（注册发生在 session_start），需 `/reload`/重启；`/workflows run <id>` 立即可用 |

## 解决方案（用户视角）

1. 首选：`/reload`（会重建扩展实例并重新触发 `session_start`，同时保留会话内容）。
2. 或退出重启 `pi`（同样生效，但会开始新会话或 resume）。
3. 临时：继续用 `/workflows run <id>`，不受命令表残留影响。

## 预防/注意事项

1. **任何动态斜杠命令都必须「调用时求值」**：不要在注册闭包里冻结 workflow 脚本或存在性判断，
   每次 handler 触发都重查外部事实源（注册表/文件/配置）。这是宿主无法注销命令时唯一的安全网。
2. 面向用户的文案必须写明「需 `/reload` 或重启生效」，否则用户会当成 bug
   （见 `unregister` 子命令提示）。
3. 不要尝试通过重复 `registerCommand` 或自行构造 `pi.getCommands()` 过滤来"隐藏"命令——
   `getCommands()` 是只读快照，宿主补全与分发都不读取它的过滤结果。
4. 升级 pi 时先核对 `loader.js` 的 `registerCommand` 是否新增了注销/替换能力；若新增，可去掉文案里的限制说明。

## 验证记录（2026-11-20）

用临时项目复现：manifest 含 `smoke_test` 时注册顶层命令 → 清空 manifest → 同一 handler 调用：

```
会话启动注册: [ 'smoke_test' ]
再调 /smoke_test: [ '[warning] workflow "smoke_test" 已注销（/smoke_test 命令残留到会话重启，重启后消失）' ]
执行链触达次数: 0
```

## 参考

- 宿主源码：`pi-coding-agent/dist/core/extensions/loader.js`（registerCommand 无注销）、
  `dist/core/extensions/runner.js`（getRegisteredCommands 从扩展 Map 汇总）、
  `dist/core/agent-session.js`（reload 重建 runner 与扩展实例）
- 第三方同款结论：`thirdparties/pi-dynamic-workflows/src/saved-commands.ts` 注释
  「Pi cannot unregister a slash command」+ 调用时 `loadWorkflow()` 重查
- 本插件实现：`extensions/commands/workflows/direct-commands.ts`（`makeDirectHandler` 调用时查表）
