# optimize 后台 deliver 在 `pi -p` 模式下报 stale ctx（产物不受影响）

## 问题现象

用 `pi -p "/workflows optimize ..."` 自测时，进程尾部只打印一行：

```
[pi-code-mode] 后台结果回传失败: This extension ctx is stale after session replacement or reload. ...
```

看不到优化摘要回传。

## 排查与根因

- optimize 已后台化（`extensions/commands/workflows/optimize/index.ts` ~L135）：命令先 register run 立即返回，主体在后台跑，完成后经 `deps.deliver` 回传摘要。
- `deliver` 由主入口 `extensions/pi-code-mode.ts:196` 实现，使用**捕获的 command ctx**。
- `-p` 非交互模式下，prompt 轮次结束后宿主替换/失效 session ctx；数十秒后后台 optimize 完成，deliver 再用旧 ctx → 抛 stale ctx 错误（被 catch 后 console.error，即上面那行）。

## 影响

**仅影响结果回传展示，不影响执行与落盘**：run 正常完成，`session.json` / `review.md` / `patchset.json` / `optimize-report.html` / before/after 报告全部落盘。交互式 TUI 会话存活期间 deliver 正常。

## 解决方案（当前约定）

- `-p` 模式自测以落盘产物为证据（与 CLAUDE.md「证据优先级：落盘文件 > stdout」一致），stale ctx 报错可忽略。
- 若要彻底修复：deliver 回调应改用 withSession 内的最新 ctx 或容忍失效（打印降级日志即可），见 `extensions/pi-code-mode.ts:196` 一带。

## 预防/注意事项

- 自测清单中「结果回传能看到候选摘要」在 `-p` 模式下改查 `review.md` 的结论段（含候选 diff 与审查 findings）。
- 相关观察：O1 阶段 `session.json.validation.aiRuleCheck` 为**硬编码 `"unavailable"`**（optimize/index.ts ~L815），big 档 AI 复核实际已跑（reason 里有耗时），属状态回填缺口，待修。
- 记录时间：2026-11-24（opt-20261124-002 实测）。
