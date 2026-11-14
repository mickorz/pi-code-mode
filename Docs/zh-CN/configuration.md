# 配置参考

> 规划中的配置面，以实现为准；设计依据见 `dev-docs/design/pi-code-mode插件需求文档.md`。

## 配置项

| 名称 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| workflow 脚本目录 | 目录约定 | `.pi/workflows/*.js` | 一级目录脚本进注册表；兼容扫描 `.opencode-workflows/workflows/` |
| model-tiers | JSON 文件 | `~/.pi/workflows/model-tiers.json` | small/medium/big 分层映射到 `provider/modelId:thinking` |
| inheritMainModel | 布尔 | 待定 | 未指定 tier/model 的 agent 继承主会话模型 |
| 状态目录 | 目录 | `~/.pi/workflows/` | settings、runs、journals、saved workflows；可用 `PI_CODING_AGENT_DIR` 重定向 |

## 生效与验证

修改 tier 映射或目录约定后，pi 内执行 `/reload`；用 `/workflows` 查看已注册工作流列表确认生效。

## 升级

`pi update --extensions` 同步包安装；submodule 参考项目用 `git submodule update --remote` 固定新 commit 并更新 `thirdparties/REFERENCES.md`。

## 卸载

`pi remove <source>` 移除包；`~/.pi/workflows/` 下的运行状态需手动清理。
