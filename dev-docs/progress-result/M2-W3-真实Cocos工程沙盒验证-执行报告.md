# M2-W3-真实 Cocos 工程沙盒验证-执行报告

> 阶段：M2-W3
> 日期：2026-11-25
> 工程：`E:\CocosProjects\CocosCLI\examples\cocos_example_proj`（Cocos Creator 3.7.3，732 文件 / 30.9 MB）
> 结果：**5 PASS / 3 WARN / 0 FAIL**

## 1. 前提（必须先说清）

**本机未安装 CocosCreator 3.7.3 编辑器**：无 `COCOS_CREATOR_PATH`、无 `~/.cocoscli/config.json`、常见安装路径为空。

而 `cocoscli build` 的真实实现是：

```ts
spawn(creatorPath, ['--project', projectPath, '--build', `configPath=${configRelPath}`], ...)
```

即 **spawn CocosCreator 编辑器 GUI 二进制**（Electron 应用）。所以 GUI 构建链**无法在本机运行**，M2-W3 只能验证"真实工程 + 沙盒可承载部分"，不能宣称"真实构建已通过"。

这条必须写进正式验收报告，不得含糊。

## 2. 验证结果

| 编号 | 内容 | 结果 | 证据 |
|---|---|---|---|
| R1 | 沙盒内全量读取真实工程（732 文件 / 30.9MB，含 library 27MB） | **PASS** | 沙盒内 732 文件 / 30.9MB = 宿主侧完全一致，`missing: 0` |
| R2 | 遍历 assets 下 TypeScript 源文件（compile 前置） | **PASS** | PowerShell 计数成功（`find.exe` 在 MXC 下不可用，见 4.2） |
| R3 | 写入构建产物目录（workspace 内 `build/web-mobile/`） | **PASS** | `mkdir` + 写文件 + 回读成功 |
| R4 | 长时构建类进程 + 超时回收 | **PASS** | `timedOut=true`，5295ms，无残留 |
| R5 | 并发两工程：各自读写 + 跨工程读取被拒 | **PASS** | ra=0 rb=0，跨读泄漏=false |
| R6a | 项目外写入（`%APPDATA%` 编辑器缓存） | **WARN** | **被拒**（exit=1）→ 真实构建需显式加 `allowWrite` |
| R6b | 网络访问 cocos.com | **WARN** | **被拒**（403/blocked）→ 真实构建需 `allowedDomains` |
| R6c | CocosCreator 可执行文件 | **WARN** | 本机未安装 → GUI 构建链不可执行 |

## 3. 真实构建链的权限缺口（核心产出）

若要在沙盒内运行 `cocoscli build`，当前策略下**必然失败**，缺三项：

| 缺口 | 现状 | 需要的策略 |
|---|---|---|
| 编辑器缓存与日志写入 | `%APPDATA%` 写入被拒 | 显式 `allowWrite` 加入 Cocos 缓存目录（如 `%APPDATA%\CocosCreator`、`%LOCALAPPDATA%\CocosCreator`） |
| 许可校验 / 资源下载网络 | 网络默认全拒 | `allowedDomains` 加入 `cocos.com` 及其 CDN 域名 |
| GUI 进程与窗口 | 沙盒内 GUI 窗口仍可能打开（MXC 不隔离桌面 UI） | 需要"构建专用权限档"而非通用档 |

### 建议的构建专用权限档（将来实现，不在本轮）

```ts
// 仅用于 run_command 中已识别为构建类命令
buildProfile: {
  allowWriteExtra: [path.join(APPDATA, 'CocosCreator'), path.join(LOCALAPPDATA, 'CocosCreator')],
  allowedDomains: ['cocos.com', '*.cocos.com', 'download.cocos.com'],
}
```

实现前提：① 命令分类能可靠识别"这是构建命令"；② 该档不得被模型任意声明（必须由策略层按项目配置授予）。

## 4. 本轮发现的两个真实平台约束

### 4.1 R1 初次 FAIL 是我的测试缺陷，不是沙盒问题

初版用 `Get-ChildItem -Recurse -File` 得到 714/732（少 18 个）。加 `-Force`（隐藏文件）+ `-LiteralPath`（路径特殊字符）后为 **732/732，missing: 0**。

结论：**MXC 沙盒对工作区内的读取是完整的**，包含 27MB 的 `library` 二进制资源。

### 4.2 `find.exe` 在 MXC 下无法加载

`cmd /c ... | find /c ".ts"` → `exit=3221225794`（`0xC0000142` STATUS_DLL_INIT_FAILED）。
与 M1 阶段发现的 `bash.exe` / MSYS2 同属一类：部分控制台工具在 MXC 的受限 Token 下 DLL 初始化失败。

**登记为已知约束**：沙盒内应优先用 PowerShell 或 Node 做文本处理，不要依赖 `find.exe`、`bash.exe`、MSYS2 工具链。

## 5. 结论

- **沙盒能承载真实工程的文件规模与访问模式**：732 文件 / 30.9MB 全量读取、workspace 内写入、长时进程超时回收、并发隔离，全部实证通过。
- **但不能承载真实 GUI 构建链**：本机无编辑器，且现有策略会拦掉编辑器所需的 AppData 写入与网络。这不是 MXC 的缺陷，是**权限档粒度不足**——需要在策略层引入"构建专用权限档"。
- **Windows Sandbox 仍为 CONDITIONAL-GO**，不因本轮放行。

## 6. 下一步建议

1. **构建专用权限档**（M2-W4）：命令分类为构建类时，按项目配置追加 allowWrite/allowDomains，模型不可声明。
2. **安装 CocosCreator 3.7.3 后复跑**：把 `m2-w3-check.ts` 的 R6c 换成真实 `cocoscli build` 并比对产物 hash。
3. 未解决前，真实构建应在**沙盒外**执行（人工审批），不得默认在沙盒内静默失败。

---

## 7. 补充：真实 GUI 构建链实测（编辑器已安装于 D:\CocosSofts\Creator\3.7.3）

> 上一节的前提（"编辑器未安装"）已纠正：**CocosCreator 3.7.3 已安装**，位于 `D:\CocosSofts\Creator\3.7.3`（3.7GB Electron 应用）。
> 我的首次探测只查了环境变量与几个常见路径，漏了自定义安装目录 —— 记录此误判以免重犯。

### 7.1 沙盒外基线（作为对照）

```
cocoscli build web-mobile examples/cocos_example_proj
→ 构建成功，产物 49 文件 / 7.9MB
   build/web-mobile/src/polyfills.bundle.js  md5 5adbfb0a...
   build/web-mobile/src/system.bundle.js     md5 543e6214...
```

（注：沙盒外构建日志也有 `[Assets] excute-taskbuild-script failed!` 与若干 SyntaxError，属该示例工程自身状况；基线以"产物存在"为准。）

### 7.2 沙盒内同一命令（清理产物后）

逐层推进，每一步都暴露一个真实约束：

| 阶段 | 现象 | 根因 | 处理 |
|---|---|---|---|
| 1 | `EPERM: lstat 'E:\'`（Node 连启动都失败） | SRT 的 `buildMxcRequest` 只把 **`SystemDrive`（C:\）** 放进 readonlyPaths；工程在 **E 盘**时盘根不可读，Node 解析入口 `realpathSync` 失败 | 修复：`buildSandboxConfig` 增加 `volumeRootOf(workspace)` 到 `allowRead` |
| 2 | `目标目录不是 Cocos 3.x 工程` | 注册表把**子孙工作区**也 deny 了：CLI 目录与它内部的 `examples/cocos_example_proj` 同时登记 → CLI 读不到自己的子目录 | 修复：`getIsolationPolicy` 排除 `descendant_of_current`（工作区 = 自己拥有的一棵树，重叠登记合并为同一棵树） |
| 3 | `spawn CocosCreator.exe ENOENT` | 编辑器在 **D 盘**，不在可读范围 | 新增 `readOnlyPaths`（工具链只读路径，Runtime 提供，**非模型输入**） |
| 4 | 编辑器启动，0.9s 静默退出，退出码 1，build-raw 日志**完全为空** | 加 `writePaths`（AppData 缓存）后仍相同 | 见 7.3 |

### 7.3 关键结论：GUI Electron 应用无法在 MXC BaseContainer 内启动

逐项探测（均在沙盒内，`readOnlyPaths` 已指向 `D:\CocosSofts\Creator\3.7.3`）：

| 探测 | 结果 |
|---|---|
| `type D:\...\3.7.3\version` | **exit=0，输出 `13.1.4`** → 文件读取正常 |
| `dir D:\...\3.7.3` | **exit=1 拒绝访问** → 目录枚举被拒 |
| `CocosCreator.exe --version` | **exit=1 拒绝访问** |
| 同上 + `writePaths`（APPDATA/LOCALAPPDATA/.CocosCreator/.CocosDashboard） | **exit=1 拒绝访问** |
| 同上 + `--no-sandbox` / `--disable-gpu` / `--disable-gpu-sandbox` | 全部 **exit=1 拒绝访问** |

**判定：不是权限不足，是 MXC BaseContainer 不承载 GUI/Electron 进程启动。**
旁证：SRT 的 MXC 请求固定 `ui: { disable: false, clipboard: 'none', allowInputInjection: false }`，
且探测到的能力集包含 `canBlockGlobalUiNamespace` / `canBlockExternalUiObjects` 等 UI 阻断能力。

### 7.4 由此得出的架构结论

**`cocoscli build`（GUI 构建链）不能作为沙盒内命令。** 三条可选路线：

| 路线 | 说明 | 评价 |
|---|---|---|
| A. 构建在沙盒外执行 | 作为受控控制面操作，需显式人工审批，命令与产物记录审计 | **当前可行**，建议默认 |
| B. 无头构建 | 需 Cocos 侧支持 headless（3.7.3 未见该能力） | 待评估 |
| C. 构建命令单独走 srt-win 后端 | srt-win 用独立用户 + ACL，非容器化，可能承载 GUI | 待评估（会引入第二后端） |

**不建议**为了跑构建而放宽 MXC 权限——MXC 的 UI/进程阻断是隔离强度的一部分。

### 7.5 本轮顺带落地的三项真实修复

1. **卷根可读**（`volumeRootOf`）：非系统盘工程上的 Node 运行时必需；跨项目隔离仍由 `denyWorkspaces`（更具体）保证，W2 的 14 项复跑全绿。
2. **子孙工作区不 deny**（`descendant_of_current`）：否则"工具目录 + 其内部工程"这类合法嵌套无法工作。代价如实记录：外层可读被单独登记的内层（重叠登记合并为同一棵树）。
3. **`readOnlyPaths` / `writePaths` 通道**：工具链与缓存目录的授权入口，**必须由 Runtime/项目配置提供，不得来自模型输入**（否则模型可自行扩展权限）。

### 7.6 回归

- contract **291/0**、engine **222/0**、M2-W2 的 14 项复跑 **14/14 PASS**（策略改动未削弱跨项目隔离）

### 7.7 M2-W3 最终判定

**CONDITIONAL**（不放行 Windows Sandbox 正式验收）：

- 沙盒可承载：真实工程全量读写（732 文件 / 30.9MB）、产物写入、长时进程回收、并发隔离 —— **全部实证**
- 沙盒不可承载：**GUI 构建链**（CocosCreator/Electron 无法启动）—— 需走控制面方案 A
- 因此"真实 Cocos 构建"这一项**未在沙盒内通过**，不得据本轮宣称构建可行
