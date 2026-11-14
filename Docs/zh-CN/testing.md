# 安装与运行验收清单

> 验收基准：`thirdparties/opencode-dynamic-workflows/examples/sample-project/` 测试脚本 8 类分批（分类明细见 `dev-docs/design/pi-code-mode插件需求文档.md` 第 3 章）。

## 概览

| 批次 | 类别 | 门槛 |
|---|---|---|
| 第 1 批 | A 基础编排 + B 子工作流 | MVP |
| 第 2 批 | C 质量结构化 + D 持久化恢复 + E 隔离后台 | P1 |
| 第 3 批 | F 定时调度 + G UI 观测 + H 模型分层/基准 | P2 |

## 安装检查

- [ ] `npm run build` 产出 `dist/` 无错误
- [ ] `pi -e ./` 加载后出现 `workflow` / `workflow_control` 工具
- [ ] `.pi/workflows/`（及兼容目录 `.opencode-workflows/workflows/`）被注册表识别

## 冒烟测试

- [ ] `scripts/smoke-test.js`：3 个 agent 调用完成，返回 info + results
- [ ] `scripts/chain-root.js`：顺序链 prev 传递正确
- [ ] `scripts/native/deep_parent.js`：嵌套深度限制生效

## 最终清单

- [ ] A 类全部通过（smoke/chain/multi-tree/concurrency/acceptance）
- [ ] B 类全部通过（native 16 个 + composite 13 个，含自环拒绝、深度限制、错误传播）
- [ ] C 类通过（judgePanel/verify/checkpoint、schema 结构化输出）
- [ ] D 类通过（resume-test.js 两步法：journal 回放零 token，只重跑变化节点）
- [ ] E 类通过（worktree 隔离后主目录无残留、后台 run 结果回传主会话）
- [ ] F 类通过（schedule-test.js cron 到期触发）
- [ ] G 类人工目检（节点详情面板、进度、checkpoint 确认）
- [ ] H 类（可选）tier 回退与基准回归
