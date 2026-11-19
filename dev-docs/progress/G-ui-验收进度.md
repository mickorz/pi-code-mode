# G-ui 类脚本实机验收进度

> G UI 观测（16 脚本）：pi-tui widget、节点详情、checkpoint 确认、结构化结果展示（脱敏/截断/空态）。
> 脚本目录：`dev-examples/sample-project-acceptance/G-ui/`；后台 run 完成通知回传本会话逐个核验。
> 状态标记：✅ 通过 / ⚠️ 通过有保留 / ⬜ 未跑。

## 执行记录

### 2026-11-22 schema-result-view（run `run-1795066380553-qcs7cy`）：⚠️ 通过有保留

后台 run：2 agent + 1 tool 节点，46.1s。结果 `structured`（schema 合规）+ `bigBytes=5411` + `failedOk=false`。

| 验收点 | 结果 | 证据 |
| --- | --- | --- |
| 1. structured 详情 pretty-print（两空格缩进 + 「输出 structured」头部） | ✅ 渲染层确认 | contract `explorer-result-view.test.ts`：`structured: pretty-print 2 空格缩进` + E2E 用例通过 |
| 2. 脱敏 apiKey/authToken/dbPassword → `[REDACTED]` | ✅ | journal `entries` 原值保留（`test-key`/`test-token`/`test-pass`），REDACTED 仅出现在 `observability.agents[0].outputPreview`（预览层，符合"脱敏只作用于显示"）；contract「敏感键在渲染副本中被打码」通过 |
| 3. 大结果 >20KB 截断提示 | ⚠️ 实机未触发 | `bigBytes=5411`（5.4KB）< 20KB，模型输出不足（脚本注释已预告长度不可控）；确定性覆盖在 contract「截断: 超 20KB 截断并标记原始体积」通过 |
| 4. 失败节点空态（显示错误而非空白） | ✅ | `probe-fail.js` exit 1（23ms，timeoutMs=1 必败），`failedOk=false`，`onFailure: 'return'` 流程继续；contract「空态三分: failed→error, running→pending, 终态无结果→empty」通过 |
| 5. journal 原值不被改写（脱敏只作用于显示） | ✅ | 见验收点 2 证据：entries 原样、REDACTED 不入 entries |

- `npm run test:contract` explorer-result-view 9/9 通过（含 50 项数组封顶、preview 兜底、outputType 缺省推断）。
- 保留点：验收点 3 的实机触发依赖模型输出长度，headless 无法强控；如需实机目视截断提示，用交互 TUI 跑 `node-detail-large-result-test.js`。

## 遗留

- 验收点 1/2 的「目视」部分（面板缩进、[REDACTED] 显示效果）headless 无法核对，依赖 contract E2E 渲染断言兜底；如需人工目视，交互会话 Ctrl+B 打开 Explorer 选中 SchemaAgent 节点。
- 其余 15 个 G-ui 脚本验收记录待补（本会话早前 3 个 run journal 为其他脚本，未纳入本表）。
