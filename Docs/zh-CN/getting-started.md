# 快速开始

> 项目处于开发初期（需求与设计已完成，见 `dev-docs/design/pi-code-mode插件需求文档.md`），本文随实现进度更新。

## 前提条件

- Node.js >= 20（ESM 项目，构建用 TypeScript）
- pi agent（`@earendil-works/pi-coding-agent` >= 0.99，deferred tool exposure 需要）
- git（worktree 隔离能力依赖）

## 安装

```bash
git clone https://github.com/mickorz/pi-code-mode.git
cd pi-code-mode
npm install
npm run build
```

本地试用（不写入 settings）：

```bash
pi -e ./pi-code-mode
```

## 验证

pi 启动后确认出现 `workflow` 与 `workflow_control` 两个工具（`/tools` 或对话中触发）。

## 第一次运行

在 `thirdparties/opencode-dynamic-workflows/examples/sample-project/` 目录启动 pi，让 Main Agent 用 `workflow` 工具执行冒烟脚本：

```
用 workflow 工具执行 scripts/smoke-test.js，scriptPath 传该文件路径
```

预期：3 个子代理 agent 调用完成（1 发现 + 2 并行），返回 `info` 与 `results`。

## 下一步

- 配置参考：`configuration.md`
- 验收清单（8 类测试脚本分批跑通）：`testing.md`
