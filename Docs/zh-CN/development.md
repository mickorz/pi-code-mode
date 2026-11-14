# 贡献者指南

## 环境与常用命令

```bash
npm install        # 安装依赖
npm run build      # tsc 构建到 dist/（extension 入口加载 dist 产物，改码后必须重新构建）
npm run test       # tsx --test tests/*.test.ts（规划）
```

## 架构概览

三层结构（移植自 opencode 版，适配层参考 pi-dynamic-workflows）：

- **runtime 引擎层**：VM 沙箱、DSL 原语（agent/parallel/pipeline/sequence/fallback/race/workflow）、journal。禁止 import 任何 pi SDK。
- **session adapter 层**：唯一允许触碰 pi SDK 的层。`createAgentSession` 子会话、结构化输出、usage 统计。
- **extension 注册层**：pi package manifest、`pi.registerTool`、`pi.registerCommand`、TUI widget。

架构红线与平台差异对照见 `dev-docs/design/pi-code-mode插件需求文档.md` 第 2 章。

## 测试

- 单元测试：`tests/*.test.ts`，session runner 通过接口缝注入 fake。
- 实机验收：`thirdparties/opencode-dynamic-workflows/examples/sample-project/` 的 8 类脚本分批跑通（A+B 类 = MVP 门槛），验收标准见 `docs/testing.md`。

## 本地开发循环

改码 → `npm run build` → pi 内 `/reload` → 用 sample-project 脚本验证。宿主联调用 `pi -e ./`（本地路径），不要用 npm 包名（走 registry 缓存，本机改动无效）。

## 发布

npm 发布前核对 peerDependencies 版本门槛（pi-coding-agent），并确保 `dist/` 产物与 `extensions/` 桥接、`skills/` 资源完整。
