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

**Ctrl+B 双向生效（已解决）**：pi 的全局快捷键只挂在 default editor 的 `onExtensionShortcut` 上，
`showOverlay` 会 `setFocus(component)` 抢走焦点，因此面板打开时全局 ctrl+b 不会派发。
处理方式：overlay 组件在 `handleInput` 里自己拦 Ctrl+B 字节（``）并关闭——
"同一个键打开、再按关闭"成立，同时保留 `q`/`Esc`。

非目标：不改布局、不改 Tab、不动导航键位。

## 3. B —— 交互模型对齐（已完成 2026-11-18）

**目标**：单树 + 全屏详情两态，贴近 opencode。

- [x] B1 去掉四 Tab，改为单执行树（Tools 本就是树内节点；Journal 的 attempts 信息在详情面板呈现）
- [x] B2 详情改为**全屏**视图（等价 opencode 的 node detail route），Esc/q 返回树；不再有左右分栏
- [x] B3 键位语义对齐：`→` 展开（已展开则进首个子节点）、`Enter`/`o` 打开详情、`↑/k`、`↓/j`、`Esc/q`
      - 2026-11-18 二次调整（使用者反馈）：`Enter` 改为**进入详情**；详情滚动改 `PgUp/PgDn`；
        详情态 `↑` 改为**返回树**；树内 `PgUp/PgDn` 按页移动选中
- [x] B4 底部提示按视图给键位（tree / detail 两套），窄终端自动切短提示
- [x] B5 迁移测试：controller（Tab→两态）、render（Tab 用例→树/详情满屏用例）、overlay（enter→o、o→r 切 run）、fixes（M4 Tab 用例改为折叠等价覆盖）

### B 的实施取舍

| 项 | opencode | 本实现 | 说明 |
| -- | -------- | ------ | ---- |
| run 切换 | 侧栏同屏多棵树 | `r` 键轮换（表头显示 `runs N（r 切换）`） | pi 单 overlay 内不做多树同屏，避免树过大 |
| 详情进入 | 点击 / Enter | `o` | Enter 让给"展开"，与 opencode 列表行为一致 |
| 键位可配置 | 宿主 keybind 系统 | 面板内硬编码 + 底部提示 | pi 的 `registerShortcut` 只在 default editor 有焦点时派发，overlay 内无法复用；keybind 化不可行（见 A1 记录） |

风险（已接受）：四 Tab 的信息密度换成了单树 + 详情两态；Agents/Tools 聚合视图不再单独存在。

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
