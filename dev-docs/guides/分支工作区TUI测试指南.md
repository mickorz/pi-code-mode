# 在分支工作区测试 pi-code-mode（TUI 联调指南）

> 适用：在特性分支（如 `mickorz/sidebar`）工作区里验证插件真实 TUI 行为，**不需要先合回 main**。
> 目标读者：本仓库开发者。环境：Windows + PowerShell，或 WSL/bash。

## 1. 核心结论

`pi -e <目录>` 直接加载**指定目录的源码**，与 git 分支无关。所以在分支工作区根目录跑 `pi -e .`，
加载的就是当前分支的代码——合并到 main 不是测试的前提。

三个参数的作用：

| 参数 | 作用 |
| ---- | ---- |
| `-e .` | 直接加载当前目录的插件源码（不读 settings 里的安装配置） |
| `-n` | 不读取也不保存会话（干净起步，避免历史会话干扰） |
| 不加 `-p` | 进入**交互 TUI**；加了 `-p` 是一次性 print 模式，没有 UI，看不到面板 |

## 2. 启动命令（按你的 shell 选一个）

### 2.1 PowerShell（Windows 默认终端）

PowerShell **不支持** `VAR=1 cmd` 这种前置赋值写法（那是 bash 语法）。
这正是 `BILI_PI_INLINE=1 : 无法将"BILI_PI_INLINE=1"项识别为 cmdlet` 报错的原因。

```powershell
cd C:\Users\zhangqi95\orca\workspaces\pi-code-mode\sidebar
$env:BILI_PI_INLINE = "1"
pi -ne -e .
```

一行版（注意分号，或用 `;` 分隔两条语句）：

```powershell
$env:BILI_PI_INLINE="1"; pi -ne -e .
```

只本次生效、不想污染当前会话时：

```powershell
$env:BILI_PI_INLINE="1"; pi -ne -e .; Remove-Item Env:BILI_PI_INLINE
```

### 2.2 bash / WSL / Git Bash

```bash
cd /d/DevTools/.../pi-code-mode        # 或 WSL 下对应路径
BILI_PI_INLINE=1 pi -ne -e .
```

bash 的前置赋值只对这一条命令生效，无需清理。

### 2.3 关于 `BILI_PI_INLINE`

它属于**环境相关**的可选开关：并发跑多个 pi 会话时 bili 代理（默认 `127.0.0.1:18787`）会端口冲突。
`BILI_PI_INLINE=1` 让本会话不起代理。若只有单个会话、或本机没装该扩展，可以省略：

```powershell
pi -ne -e .
```

## 3. 测试流程

### 3.1 启动前：类型关卡

```powershell
npm run build          # src + extensions 双份 tsc（宿主与单测都不做类型检查，只有这一步拦得住）
```

> `build` 现在会额外跑一遍 `tsconfig.extensions.json`。原因是 extensions 曾长期不在类型检查范围内，
> 导致 `getArgumentCompletions` 里的未定义变量一直没被发现，按 Tab 补全直接崩宿主
> （见 `dev-docs/experience/extensions-未类型检查导致宿主崩溃.md`）。

### 3.2 自动化验证（不需要 TUI）

```powershell
npm run test:contract  # 命令装配、Explorer 状态机/渲染、Journal、事件协议
npm run test:engine    # 引擎语义（含 runTool / composite / resume）
```

### 3.3 交互 TUI 验证（本文重点）

1. 启动：见第 2 节。
2. 制造一个 run（二选一）：
   - 在会话里让 agent 调用 `workflow` 工具执行脚本；
   - 或 `/workflows run <脚本路径|注册表名>`。
3. 打开面板（两种入口都可用）：

   - **快捷键 `Ctrl+B`**：一键开关（对齐 IDE 手感，不用记命令）；**面板打开时再按 `Ctrl+B` 即关闭**
     （注意：若你的终端把 `Ctrl+B` 当 tmux 前缀，需先按两次前缀或在别处改键）
   - 或斜杠命令：

   ```text
   /explorer
   ```

   或直接定位某个 run：

   ```text
   /explorer run-xxxxxxxx
   ```

4. **先按一次 Tab 补全**（`/workflows ` 或 `/explorer ` 后按 Tab）：
   这是暴露“装配期引用错误”的最短路径——那类错误没有降级，会直接打死宿主进程。
   补全正常出现候选后再继续。

5. 逐项核对（对应 Explorer 的验收点）：

   | 操作 | 期望 |
   | ---- | ---- |
   | 启动后可见标题 | 面板标题为 `Workflow Explorer`（证明加载的是本分支代码） |
   | 不打开面板时 | 底部状态区出现在途 run 单行进度（如 `workflow 需求分析 1/2 · 1 running`），跑完自动消失 |
   | `Ctrl+B` | 打开面板；**面板打开时再按一次关闭**（同一键双向） |
   | `↑` `↓`（或 `k` `j`） | 树内移动选中行 |
   | `PgUp` `PgDn` | 树内按页移动选中；**详情态按页滚动** |
   | `→` | 展开子节点；已展开则进入第一个子节点 |
   | `←` | 收起；已收起则回到父级 |
   | `Enter` 或 `o` | 打开当前节点的**全屏详情**（prompt / result / attempts / 路径） |
   | 详情态 `↑` | **返回树**（滚动用 PgUp/PgDn） |
   | 详情态 `←` `→` | 上一个 / 下一个节点（不退出详情） |
   | `Esc` 或 `q` | 详情态 → 返回树；树态 → 关闭面板 |
   | 详情态 `End` / 连续 `PgDn` | 停在最后一行，**不出现整屏空白** |
   | `r` | 多个 run 之间轮换（表头 runId 与树同步变化） |
   | `Ctrl+B` 或 `q` | 关闭面板 |
   | 关闭后重开 `/explorer` | 选中节点、视图态（树/详情）、折叠状态保持（单实例常驻语义） |
   | 运行中打开、等 agent 完成 | 节点状态自动刷新；**详情能看到新写入的 prompt/result**（不陈旧） |
   | 终端调窄到 ~80 列 | 树/详情仍满屏可用，行不超宽不错位 |

6. 收尾：`Ctrl+C` 或 `/exit` 退出会话。

## 4. 常见问题

| 现象 | 原因 / 解法 |
| ---- | ----------- |
| `无法将"BILI_PI_INLINE=1"项识别为 cmdlet` | PowerShell 不支持 bash 前置赋值；改 `$env:BILI_PI_INLINE="1"; pi -ne -e .` |
| `/explorer` 提示"需要 TUI 交互终端" | 用了 `-p`（print 模式）或非交互环境；去掉 `-p` |
| 启动后看不到面板、`/explorer` 无反应 | 确认 `-e .` 指向仓库根（含 `package.json` 的目录），不是 `src/` 等子目录 |
| 加载的是旧代码 | 确认没有把 `pi install` 的全局版本一起加载；用 `-ne`（跳过已装扩展） |
| 端口冲突 / 多个会话互相干扰 | 用 `BILI_PI_INLINE=1`，或给另一会话设 `ACP_PORT=18799` |
| 面板样式错乱、边框错位 | 终端宽度不足或被别的 widget 挤占；放大窗口后再开 `/explorer` |
| 按 Tab 补全时 pi 直接崩溃（uncaughtException） | 装配期闭包引用错误或宿主回调抛异常；先 `npm run build`（含 extensions 检查），再看 `dev-docs/experience/extensions-未类型检查导致宿主崩溃.md` |

## 5. 分支 vs main 的差别

| 场景 | 是否需要合回 main |
| ---- | ----------------- |
| 验证当前分支的代码行为 | **不需要**，`pi -ne -e .` 直接加载工作区源码 |
| 验证"按项目默认安装配置启动"的集成效果 | 需要（main 的 `.pi/settings.json` / 安装方式为准） |
| 验证发布产物（`dist/`） | 需要 `npm run build`；宿主本身经 jiti 直载 TS，不看 `dist/` |

## 6. 与仓库纪律的对应关系

- `src/` 改动后先 `npm run build`，再进 TUI 测试（类型检查唯一关卡）。
- 宿主经 jiti 直载 `extensions/` 与 `src/` 的 TS 源码，**改完源码重启 pi 即生效**，不存在"测到旧 dist"。
- 长时联调用例并发 ≤2，agent 链类预算 ≥20 分钟，短流程 5-8 分钟；验收以 journal / run 快照落盘证据为准。
