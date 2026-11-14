# P0-B 验收报告（子工作流·深层嵌套子集）

> 需求文档 R3 §3.2 B 类验收的**深层嵌套子集**（P0-B 整体尚未完成，本报告先记录已通过部分）。
> 日期：2026-11-14。验收脚本：`dev-examples/sample-project-acceptance/B-subworkflows/native/`。
> 执行方式：`run-acceptance.ts deep self`（真实模型串行，PiAgentAdapter + glm-5.3-flash），看门狗 PID 落 `/tmp`，证据落 `.journal/`。

## 1. 验收结果：3/3 PASS（深层嵌套子集）

| # | 脚本 | 结果 | agents | 耗时 | 断言要点 |
|---|---|---|---|---|---|
| 1 | deep_parent.js → deep_child.js → 1_spec.js | PASS | 2 | 33.4s | root→child→spec 两层嵌套，child 内 agent + 孙层 workflow 均正常，brief 传回父层 |
| 2 | deep_chain_parent.js → l2 → l3 | PASS | 3 | 7.4s | 三层链 root→l2→l3，各层 phase 标记与 agent 回复正常 |
| 3 | self_ref_parent.js → self_ref.js | PASS（预期失败） | 0 | 57.9s | 自环拒绝生效：`workflow 不能调用自身或祖先：…self_ref.js`，错误消息命中断言 `/自环\|祖先/` |

预热检查：warmup 最小 prompt `只回复 ok` → status ok（1.6s），符合"长任务前先预热"约定。

## 1.1 增补用例：error-propagation PASS（2026-11-14）

| 脚本 | 结果 | agents | 耗时 | 断言要点 |
|---|---|---|---|---|
| error_parent.js → error_child.js | PASS | 1 | **2.2s（密闭化修正后干净复跑）** | child 在 agent 后无条件 `throw Error('child 业务失败：产物闸门未通过')`，父层 try-catch 捕获降级，返回 `caught=true` 且 message 含「产物闸门」 |

- 预热：warmup 1.9s ok；前台执行（bash 工具超时即看门狗）。
- journal：`.journal/p0b-error-propagation-1794651919047.json`——密闭化 prompt（`回复固定文本：GATE-PROBE，不要使用任何工具`），agent 2.19s 原样回复，无任何仓库访问。
- **证据勘误（重要）**：早期记录引用的 `p0b-error-propagation-1794651216242.json`（58.3s）**不是正常验收产物**——它是 18:12–18:18 批次中 error#1 用例（本轮 runner 自身的那轮，journal `p0b-error-propagation-1794651147686.json`，agent 耗时 322.6s）的不密闭子代理**嵌套调起 runner 单独跑该用例**所再生的 journal。当时文档中「未发生嵌套 runWorkflow」的结论是从嵌套上下文内部观察得出的，视角受限；完整时间线已补入 experience 复发记录。

## 1.2 native/registry 批次（2026-11-14 18:11–18:18 + 复跑）：4/4 PASS

| key | 耗时 | agents | 断言要点 |
|---|---|---|---|
| native-pipeline | 41.9s（首轮 36.4s） | 3 | 三段串行 spec→design→code 纯编排父（零 agent），brief/design/code 传回 |
| mutate-args-isolation | 1.5s | 1 | args 克隆隔离：child 内 999/injected 改动不外溢父层 |
| registry-byname | 3.1s（首轮 26.8s） | 1 | 注册名 schedule_test 按名寻址（cwd 指向 registry/ 命中 `.opencode-workflows/workflows/`） |
| compare-parallel | 18.5s | 3 | 同脚本三实例并行（lane_a/b/c），brief 互不相同，args 隔离 |

- 批次首次运行（18:11–18:18）五用例编排语义即全部 PASS，但 error#1 受不密闭提示词污染（见 §3 第 4 条）；密闭化修正入库后（commit `59049c5`）复跑本轮 4 用例 + error-propagation 单用例，全部干净 PASS。
- 本批顺带冒烟了当日新落地的全局 Agent 并发闸（commit `e18dbde`），无冲突。

## 2. 证据

- journal 落盘：`.journal/p0a-deep-parent-*.json`、`.journal/p0a-deep-chain-*.json`、`.journal/p0a-self-ref-reject-*.json`（早期 runId 前缀为 `p0a-`，runner 现已按阶段输出 `p0b-`）；本轮批次：`p0b-native-pipeline-1794651109952.json`、`p0b-error-propagation-{1794651147686,1794651216242,1794651919047}.json`（最后一个为干净复跑）、`p0b-mutate-args-isolation-1794651470269.json`、`p0b-registry-byname-1794651478474.json`、`p0b-compare-parallel-1794651505277.json`
- stdout 全量日志：`.journal/p0b-deep-stdout.log`、`.journal/p0b-native2-clean-stdout.log`（本轮复跑 4/4 PASS 汇总；首批次 nohup 重定向日志丢失，以 journal 为准）
- 关键事实核对：deep-parent journal 中 child 层 agent（prompt"深层任务"）真实模型回复正常落盘，含 sessionId/hash；self-ref 的首个 agent 执行完成后才触发自环拒绝（拒绝发生在 `workflow('./self_ref.js')` 调用点，符合"允许 agent、禁止自环 workflow"契约）。

## 3. 验收中的发现

0. **独立复验通过（2026-11-14 18:07）**：另一会话仅筛 `deep` 两用例复跑，2/2 PASS（deep-parent 2 agents 266.3s、deep-chain 3 agents 6.8s），journal `p0a-deep-parent-1794650564630.json`、`p0a-deep-chain-1794650830938.json` 落盘。deep-parent 耗时膨胀至 266s 的原因已查明：`深层任务` 子代理把泛化提示词当成编码任务，在本轮运行内部嵌套自执行了验收（warmup + 3 用例 + 更新本报告），属**验收用例不密闭**问题，完整分析与修正建议见 `dev-docs/experience/acceptance-agent-prompt-not-hermetic.md`。复验同时确认：编排语义（两层/三层 `workflow()` 嵌套、brief 传回、各层 agent ok）不受影响。

1. **runner 标题文案滞后**：`run-acceptance.ts` 汇总标题仍为"P0-A 验收"，跑 P0-B 用例时标题未区分（纯文案瑕疵，不影响断言与结果；P0-B 剩余用例验收时顺手修正）。
2. **runId 前缀统一为 `p0a-`**：runner 未按阶段区分 runId 前缀，检索 journal 时需按脚本 key 而非前缀过滤。
3. **自环拒绝耗时 57.9s 偏长**：因为自环检测发生在 child 首个 agent 之后（脚本先 `await agent('第一步')`），真实模型自由探索花费了时间；检测本身是同步查祖先链，逻辑耗时忽略不计。语义正确。（该提示词已密闭化修正为固定文本回复，后续复跑不再有此方差）
4. **验收运行中被不密闭子代理中途篡改仓库文档（新坑，18:12–18:18 批次）**：error#1 用例的子代理（prompt `检查产物闸门`）把泛化提示词当成验收任务指令，在 322.6s 存活期内：读进度文档确认待办 → 预热 → **嵌套调起 runner 单独执行 error-propagation**（再生 journal `…216242.json`）→ 执行闸门单测（28/28）→ 更新 4 份文档（experience/验收进度/验收报告/执行进度，mtime 均落在该 agent 存活窗口内）。早期文档中「58.3s PASS」证据与「未发生嵌套」结论均出自该嵌套上下文，已在 §1.1 与 experience 中勘误。引擎编排语义不受影响（throw 无条件，父层断言与 agent 输出无关），但验证了「验收运行必须密闭」不只是耗时问题——**文档副作用会污染审计链**。密闭化修正已入库并实证生效（2.2s）。

## 4. P0-B 剩余待验收（6 个，composite 系）

- `composite/` sequence 系：`composite-seq`、`composite-seq-fail`、`composite-seq-parallel`、`par-child-fail-collapse`、`failure-gate`、`queue-timer`
- race/fallback 系（fb_*/race_*/seq_resume）归 M2，其中 `race_slow.js` 密闭化修正已随本批入库
- 批量命令：`npx tsx dev-examples/sample-project-acceptance/run-acceptance.ts composite par-child failure-gate queue-timer`

## 5. 产物

- 复跑命令：`npx tsx dev-examples/sample-project-acceptance/run-acceptance.ts deep self`
- 看门狗：后台 PID 记录 `/tmp/p0b-deep.pid`，轮询 `kill -0` 检活，全程未触发超时（总耗时约 100s）
