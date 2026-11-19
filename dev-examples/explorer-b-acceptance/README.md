# Explorer B 交互验收（单树 + 全屏详情）

> 验证目标：交互模型是否真的对齐 opencode —— 单树、Enter 展开、`o` 进全屏详情、详情态左右切节点。

## 1. 准备

```powershell
cd C:\Users\zhangqi95\orca\workspaces\pi-code-mode\sidebar
npm run build          # 类型关卡（src + extensions）
```

## 2. 启动

```powershell
$env:BILI_PI_INLINE="1"; pi -ne -e .
```

## 3. 制造一棵多层树

在会话里说：

```
用 workflow 工具执行 dev-examples/explorer-b-acceptance/tree-sample.js，scriptPath 传这个相对路径
```

这个脚本会产出：root workflow → 5 个 phase → 并行 agent / 子 workflow（含自己的 phase）/ sequence 组合节点 / runTool 工具节点。

> 想同时验证多 run 轮换：再跑一次同一个脚本（runId 不同），或让其中一个跑着不动。

## 4. 打开面板

按 **`Ctrl+B`**（或 `/explorer`）。

## 5. 逐项验收（B 的全部行为）

### 5.1 单树（B1）

- [ ] 面板**没有** Workflow/Agents/Tools/Journal 的 Tab 栏
- [ ] 首行是当前 run 摘要：`[RUN] <label> (done/total)`，多 run 时右侧有 `· runs N（r 切换）`
- [ ] 树里能看到 7 类节点：run(`*`)、workflow(`#`)、phase(`>`)、agent(`-`)、composite(`+`)、tool(`=`)
- [ ] 子 workflow 缩进在父 workflow 之内，且它的 phase 带 `▸ 子分支 / ` 前缀

### 5.2 键盘语义（B3）

- [ ] `↑` / `k`：选中行上移；`↓` / `j`：下移
- [ ] `→`：展开（`>` 变 `v`）；已展开时再按 → **选中跳到第一个子节点**
- [ ] `Enter`：行为与 `→` **一致**（只展开，**不进详情**）
- [ ] `←`：已展开则收起；已收起则**回父级**
- [ ] `Home` / `End`：跳到首/末节点
- [ ] `o`：进入**全屏详情**（整屏都是详情内容，看不到树）
- [ ] 详情态 `←` / `→`：切到上/下一个节点（详情内容随之变化）
- [ ] 详情态 `↑` / `↓`：滚动详情；`End` 停在最后一行且**不出现整屏空白**
- [ ] 详情态 `Esc` 或 `q`：**返回树**（不关闭面板）
- [ ] 树态 `Esc` 或 `q`：关闭面板
- [ ] `Ctrl+B`：面板打开时再按一次**关闭**（双向）

### 5.3 详情内容（B2）

进 `o` 后逐项确认（选中不同节点各看一次）：

- [ ] agent 节点：`-- prompt --`、`-- result --`、`-- attempts (N) --`（有重试时）、`路径:` 祖先链
- [ ] tool 节点：状态、耗时、无 prompt 区块（不显示 undefined / [object Object]）
- [ ] phase / workflow 节点：耗时、错误区（失败时）
- [ ] 详情行宽不超过面板宽度，中文不串行

### 5.4 run 轮换（B 的取舍项）

- [ ] `r`：在多个 run 之间轮换，表头 runId/label 与树同步变化
- [ ] 切到已看过的 run，**该 run 的选中节点与折叠状态保留**

### 5.5 实时性

- [ ] run 仍在跑时打开面板：节点状态自动刷新（RUN → OK/FAIL）
- [ ] 某个 agent 跑完后再进它的详情：能看到**新写入的** prompt/result（不是陈旧空值）

### 5.6 窄终端

- [ ] 把终端缩到 ~80 列：树/详情仍满屏可用，行不超宽、不错位
- [ ] 底部提示自动切成短版（`↑↓ 选择  → 展开  o 详情  q 退出`）

## 6. 自动化回归（先跑，缩小人工范围）

```powershell
npx tsx --test tests/contract/explorer-*.test.ts
```

覆盖：树模型、Controller 两态、渲染、Overlay 键位、快捷键/状态行、Journal 详情、e2e。

全量：

```powershell
npm run test:contract
npm run test:engine
```

## 7. 不需要真实模型的布局预览

```powershell
npx tsx dev-examples/explorer-preview/render-preview.mts 90 16 tree
npx tsx dev-examples/explorer-preview/render-preview.mts 90 16 detail
```

## 8. 出问题怎么定位

- 面板样式/内容不对 → 先看预览脚本同宽度输出，判断是数据问题还是渲染问题
- 按键无反应 → 确认焦点在面板（标题栏可见），`Ctrl+B` 是否被 tmux 前缀吃掉
- 面板崩溃退出 → 先 `npm run build`（含 extensions 检查），再看 `dev-docs/experience/extensions-未类型检查导致宿主崩溃.md`
- 详情数据为空 → 确认该 agent 是否真的完成过（失败/中止的节点没有 result，只有 attempts）
