# 常见问题排查

## 安装

**pi 加载后没有 workflow 工具**
- 检查 pi 版本：deferred tool exposure 需要 pi >= 0.99；旧版本工具不进 system prompt，需靠 tool_search 发现或升级宿主。
- 确认先执行了 `npm run build`：extension 桥接加载的是 `dist/` 编译产物，缺产物时注册静默失败。
- 本地试用用 `pi -e ./`（本地路径），npm 包名形式会走 registry 缓存装旧版本。

## 运行

**脚本被拒绝执行：检测到非确定性调用**
- 沙箱禁止 `Math.random` / `Date.now()` / 无参 `new Date()`；随机性与时间戳应在 agent prompt 或宿主侧处理，不要在编排脚本里生成。

**子代理里又出现了 workflow 工具（递归套娃）**
- 子会话必须禁用宿主扩展与 workflow 系工具（`noExtensions` + `excludeTools`）。若在 providerMiddlewareExtensions 白名单放行了本包，会重新引入递归风险，移除白名单项。

**注册表里找不到我的工作流**
- 只有 workflow 目录**一级**的 `*.js` 进注册表；子目录脚本只能用显式路径引用。确认目录是 `.pi/workflows/` 或兼容的 `.opencode-workflows/workflows/`。

**resume 后结果不对**
- journal 按调用位置索引回放，脚本的前缀结构变了会导致错位；先跑原脚本确认 journal 有效，再小步修改。

## 仍未解决

- 查 `dev-docs/experience/` 是否有已沉淀的同类问题。
- 带 journal 与 run snapshot 落盘文件（不要只贴终端输出）到 issue tracker。
