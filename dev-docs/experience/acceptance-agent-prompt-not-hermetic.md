# 验收用例中自由 agent 提示词过泛导致"用例不密闭"（嵌套自执行验收）

> 日期：2026-11-14。关联：P0-B 深层嵌套验收（`deep-parent` 用例）。发现于 P0-B 首轮验收后的独立复验。

## 问题现象

P0-B `deep-parent` 用例（`deep_parent.js → deep_child.js → 1_spec.js`）复验时耗时 **266s**，而子代理此前自跑同用例仅 **33.4s**。journal（`.journal/p0a-deep-parent-*.json`）中 `深层任务` 提示词的 agent 回复出现大段验收执行摘要（含 warmup、看门狗、3 用例结果表、文档更新说明），而非简短应答；`.journal/` 内混入了由该 agent 再生的 3 个 journal（18:04–18:05 时间戳）；`dev-docs/progress-result/P0B-验收报告.md`、`dev-docs/progress/执行进度.md` 被这个验收运行内部的子代理创建。

## 排查过程

1. 对比两次运行时长：266s vs 33.4s，差异 8 倍，疑似 agent 自由发挥了。
2. 读 journal 落盘证据（优先级高于 stdout）：`深层任务` agent 的 result 是完整验收执行叙述，且提到"更新 P0B-验收报告/执行进度"。
3. 核对文件时间戳：再生 journal 与文档 mtime 均落在本次 `deep-parent` 运行窗口内，实锤嵌套自执行。

## 根因

`deep_child.js` 的 `await agent('深层任务')` 提示词过泛（只有 4 个字），而 PiAgentAdapter 的子会话**默认带工具、cwd 是验收脚本目录**（`B-subworkflows/native/`）。模型把模糊提示词理解为"执行深层任务验收"这一编码任务，于是自行 warmup → 跑 `run-acceptance.ts`（嵌套真实模型调用）→ 核对 journal → 更新仓库文档。验收用例变成**非密闭**：

- 耗时不可控（33s → 266s，受模型行为方差支配）；
- journal 审计目录被嵌套 run 污染（同名前缀混入非本轮产物）；
- 验收运行内部改动了仓库文档（测试产生副作用）。

注：**未发生无限递归**——嵌套 run 里该 agent 这次的应答较收敛（33.4s）。这是模型行为运气，不是引擎防护：`agent()` 通道不受 `workflow()` 深度限制/自环拒绝约束，agent → 外部命令 → 再 runWorkflow 的环路在引擎控制之外。

## 解决方案

验收用例中的自由 agent 提示词必须**密闭化**（纯生成、与仓库状态无关），例如把 `agent('深层任务')` 改为 `agent('用一句话说明什么是函数嵌套调用')`。修改对象是本仓库的分类副本（`dev-examples/sample-project-acceptance/`），不触碰只读 submodule。备选方案（引擎层）：`agent()` 支持默认禁用工具的 policy（受限仅生成），可一劳永逸消除此类方差，待 M2 评估。

本次复验未改脚本：该用例断言（agent ok + brief 传回）两次运行均 PASS，嵌套行为不改变编排语义判定，修正留给下一批脚本改动统一处理。

## 复发记录

- **2026-11-14 18:12–18:18，`error-propagation` 用例**（`error_child.js`，第二批验收）：同类不密闭，且**首次观测到嵌套 runner 调起与文档副作用**。批次中 error#1 用例（本轮 runner 自身，journal `p0b-error-propagation-1794651147686.json`）的子代理（prompt `检查产物闸门`）在 322.6s 存活期内：读进度文档确认待办 → 预热 → **嵌套调起 runner 单独执行该用例**（再生 journal `p0b-error-propagation-1794651216242.json`，其 agent 58.3s 内跑了闸门单测 28/28 并产出审计报告）→ 更新 4 份仓库文档（experience/验收进度/验收报告/执行进度，mtime 均落在该子代理存活窗口内）。早期记录中「58.3s PASS」「未发生嵌套 runWorkflow」的结论正是从该嵌套上下文内部写出的，视角受限，已在 P0B 报告 §1.1/§3 勘误。与首例一致：编排语义判定不受影响（child 无条件 throw，父层断言与 agent 输出无关），但教训升级——**不密闭不只是耗时方差，验收运行内的文档副作用会污染审计链**。
- **修正效果实证（2026-11-14 晚）**：密闭化修正（`error_child.js`/`deep_child.js`/`self_ref.js`/`queue-timer-test.js` 入库于 commit `59049c5`，`race_slow.js` 随后补充）后干净复跑：error-propagation **2.2s PASS**（journal `p0b-error-propagation-1794651919047.json`，agent 原样回复 GATE-PROBE，无仓库访问），对比不密闭轮 322.6s，差 145 倍；同批 `mutate-args-isolation`（1.5s）/`registry-byname`（3.1s）/`compare-parallel`（18.5s）/`native-pipeline`（41.9s）全部干净 PASS。

## 预防/注意事项

1. 新验收脚本评审时检查所有 `agent()` 提示词：出现指向“本仓库/本验收/执行 XX”语义的短泛词即不密闭，需改为纯生成任务。已固化为入库前检查项（本轮 5 个脚本已全部修正）。
2. 读验收结果先看 journal 时间戳与 agent 回复内容，警惕“agent 回复像执行日志”的用例（本次即由此识破）；**同时核对文档 mtime 是否落在验收运行窗口内**（本次凭 mtime 实锤中途篡改）。
3. 长耗时异常（同用例倍数级差异）优先怀疑 agent 自由发挥，而非限流。
4. 同名用例出现多份 journal 时，先区分“哪份是 runner 主流程产物”（runId 时间戳应与 runner 启动顺序连续），其余的视为嵌套再生污染源。
