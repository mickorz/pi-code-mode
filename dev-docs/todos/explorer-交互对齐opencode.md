# Workflow Explorer 交互对齐 opencode（backlog）

> 建立时间：2026-11-18
> 背景：Explorer 落地后，操作手感与 REF-001（`thirdparties/opencode-dynamic-workflows`）差异较大。
> 已完成的差异归因见本文 §1；本节以下三项按性价比排序，**A 已排期先做**。

## 1. 差异归因（结论，避免重复讨论）

| 差异点 | 类型 | 说明 |
| ------ | ---- | ---- |
| 右侧栏不能常驻 | **宿主硬限制** | pi 只有 `setWidget(aboveEditor\|belowEditor)` 与 `ctx.ui.custom({overlay})`，没有 opencode 那种 `sidebar_content` Dock 插槽 |
| Enter 不能"打开 agent 子会话" | **半硬限制** | pi 有 `switchSession(path)`，但子 agent 是 `createAgentSession` 内存态会话，没有可切换的 session path |
| 必须手打 `/explorer` 才能打开 | **本仓库取舍** | pi 有 `pi.registerShortcut()`，当初没接 |
| 四 Tab + 左树右详情双栏 | **本仓库取舍** | 为容纳 Tools/Journal；opencode 是单树 + 全屏详情路由 |
| 键位硬编码、帮助里看不到 | **本仓库取舍** | 未接宿主 keybind 系统，只在 overlay 内部 `handleInput` 解析 |
| 在途状态显示在编辑器上方 | 位置差异 | opencode 用 `session_prompt_right`（输入框右侧）；pi 用 widget（上方） |

附带约束：pi 的 `shift+tab` 已被 `app.thinking.cycle` 占用，Explorer 的 Shift+Tab 只能在 overlay 内部生效。

## 2. A —— 入口与状态可见性对齐（已完成 2026-11-18）

**目标**：不用记命令就能开面板；不打开面板也能看到在途 run。

- [x] A1 `pi.registerShortcut("ctrl+b", ...)` 一键开关 Explorer（`ctrl+b` 在 pi 内置 keybind 中未被占用）；再次触发关闭当前 overlay
- [x] A2 用 `ctx.ui.setStatus("workflow", text)` 常驻显示在途 run 单行进度（如 `workflow 需求分析 1/2 · 1 running`），run 结束自动清空
- [x] A3 保留 `/explorer [runId]` 命令（脚本化/可发现性入口不变）
- [x] A4 契约测试：快捷键注册存在、toggle 语义（开→关→开）、状态文本纯函数、无在途时清空、卸载后停止写入

落地文件：`extensions/explorer/index.ts`（toggle/close 句柄）、`extensions/explorer/status-line.ts`（状态行）、
`extensions/pi-code-mode.ts`（ctrl+b + session_start/shutdown 接线）、
`tests/contract/explorer-shortcut-status.test.ts`（6 用例，contract 134 → 140）。

已知限制（实测前需确认）：overlay 获得键盘焦点时，宿主是否仍派发全局快捷键；
若不派发，面板打开时仍需用 `q`/`Esc` 关闭，`ctrl+b` 只负责"打开"。

非目标：不改布局、不改 Tab、不动导航键位。

## 3. B —— 交互模型对齐（待评估）

**目标**：单树 + 全屏详情两态，贴近 opencode。

- [ ] B1 去掉 Workflow/Agents/Tools/Journal 四 Tab，改为单执行树（Agents/Tools 作为树内节点已存在，Journal 信息并入详情面板）
- [ ] B2 详情改为独立全屏路由视图（opencode 的 `node detail route` 形态），Esc 返回树
- [ ] B3 键位语义对齐：`enter` 展开/进入首个子节点，`o` 打开详情；`up/k`、`down/j`、`escape/q`
- [ ] B4 键位接入宿主 keybind 提示（在面板底部显示可配置键位而非硬编码文案）
- [ ] B5 迁移既有测试（controller / render / overlay / e2e 与 Tab 相关的断言）

风险：破坏现有四 Tab 的信息密度；Journal/Attempts 需要有新的落点。

## 4. C —— 真常驻侧栏（远期，可能不做）

**目标**：右侧固定面板，主对话区自动缩窄，不遮挡聊天。

- [ ] C1 技术选型：REF-007 `pi-sidebar-tui` 的 terminal compositor 路线（缩窄主终端渲染宽度后右侧独立绘制）vs 维护 Pi TUI 定制分支
- [ ] C2 验证 compositor 与宿主渲染循环、resize、焦点、其他 widget 的共存
- [ ] C3 明确代价：非官方扩展点，Pi 升级易碎；需持续回归

结论倾向：除非 B 做完仍不满足，否则不做 C。优先把体验差异压到"入口/布局"层面即可。

## 5. 执行顺序

1. **A**（当前）→ 验证手感
2. 视反馈决定 B
3. C 保持不做，除非出现明确需求
