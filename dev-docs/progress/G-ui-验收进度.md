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

### 2026-11-22 schema-result-view 复跑（run `run-1795073286240-spy5ng`）：✅ 通过（保留点同上）

同日第二次后台 run：2 agent + 1 tool 节点，51.4s。结果与上次一致：`bigBytes=5411`（120 行模板行格式固定，完全合规时字节数确定，模型完全照做）、`failedOk=false`（`onFailure: 'return'` 预期）。增量核验：

- journal `entries` 原值保留（`demo-key-001`/`demo-token-001`/`demo-pwd-001`），`[REDACTED]` 仅在 `observability.agents[0].outputPreview`，与验收点 5 结论复验一致。
- contract `explorer-result-view.test.ts` 升至 **11/11**（上次 9/9，其间补 2 个真实数据回归：失败节点 error 状态、工具节点显示错误而非「无结果返回」），本 run 数据下全部通过。
- 保留点 3 不变：模型输出仍 5.4KB 未触发实机截断，contract 用例兜底。

### 2026-11-19 subworkflow-tree-view（run `run-1795076191834-w6opf2`）：✅ 通过（目视部分待人工）

新增脚本 `G-ui/subworkflow-tree-test.js` + `subworkflow-child.js`（父 + 子双文件，workflow() 原语嵌套，scriptPath 相对项目根解析）。后台 run 7s：父 RootAgent + 串行子流程 + 并行 A/B（同脚本双实例）。

| 验收点 | 结果 | 证据 |
| --- | --- | --- |
| 1. 树层级：父下挂 3 个子 workflow 节点（# 图标、缩进） | ✅ 结构层 | journal entry 键 `<runId>:<scopePath>:<localId>`，scopePath wf0/wf1/wf2 三层；树模型三层嵌套单测（explorer-tree 8/8）通过 |
| 2. 同脚本多实例不合并 | ✅ | 并行 A/B 两个独立节点（label 区分、不同 scopePath）；同名不合并单测通过 |
| 3. 子内 phase 前缀「▸ label / 子层任务」 | ✅ | run 节点列表实测：EchoAgent(serial) (▸ 串行子流程 / 子层任务) 等三个子 agent 均带前缀分组 |
| 4. childSeq 按调用序领号（wf0/wf1/wf2 不按完成序） | ✅ | parallel-b 先完成（2331ms < 2654ms）但编号仍按调用序（wf1=并行A，wf2=并行B），节点列表顺序稳定 |
| 5. 选中子 workflow 节点看详情（scopePath、子流程耗时） | ⬜ 目视待人工 | headless 无法核对渲染面板；确定性兑底：explorer-e2e 1/1（childA/childB 嵌套树 + Journal 详情 + resume 回放）通过 |

- 确定性覆盖合计：explorer-tree 8/8 + explorer-e2e 1/1（含嵌套）。
- 保留点：验收点 5 的目视部分需交互 TUI（Ctrl+B 展开树、选子 workflow 节点看详情）。

### 2026-11-19 subworkflow-tree-view 复跑（run `run-1795077446955-y6wkwb`）：✅ 可复现

同日第二次 run（6.6s）结果形态完全一致：阶段前缀分组、wf1/wf2 调用序领号（并行B 又先完成仍编号 wf2）、args 克隆传递均复现。嵌套显示行为稳定，无新增保留点。

第三次复跑（run `run-1795078433379-4o4uqf`）三连一致；总时长 97.6s（前两次 6.5s）为调度/配额等待间隙，agent 本体 ~11s，无异常。

## 遗留

- 验收点 1/2 的「目视」部分（面板缩进、[REDACTED] 显示效果）headless 无法核对，依赖 contract E2E 渲染断言兜底；如需人工目视，交互会话 Ctrl+B 打开 Explorer 选中 SchemaAgent 节点。
- 其余 15 个 G-ui 脚本验收记录待补（本会话早前 3 个 run journal 为其他脚本，未纳入本表）。
