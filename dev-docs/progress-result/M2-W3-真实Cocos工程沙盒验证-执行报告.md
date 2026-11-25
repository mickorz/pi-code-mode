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
