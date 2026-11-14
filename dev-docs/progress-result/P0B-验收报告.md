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

## 1.1 增补用例：error-propagation PASS（2026-11-14 18:14）

| 脚本 | 结果 | agents | 耗时 | 断言要点 |
|---|---|---|---|---|
| error_parent.js → error_child.js | PASS | 1 | 58.3s | child 在 `agent('检查产物闸门')` 后无条件 `throw Error('child 业务失败：产物闸门未通过')`，父层 try-catch 捕获降级，返回 `caught=true` 且 message 含「产物闸门」 |

- 预热：warmup 1.6s ok；看门狗 480s 未触发。
- journal：`.journal/p0b-error-propagation-1794651216242.json`——runId 前缀已是 `p0b-`，汇总标题同步输出「P0 验收（P0-A/P0-B）」，§3 的第 1、2 条发现（标题文案、前缀）在当前 runner 版本已修复。
- **发现（复发）**：child 内 agent 提示词 `检查产物闸门` 触发同类不密闭行为——子代理把提示词当真实审计任务，在验收运行内部执行了闸门单测（28/28）并产出审计报告。与 deep-parent 首例不同，本用例**断言密闭性不受影响**（throw 无条件，父层断言与 agent 输出无关），仅耗时方差；未发生嵌套 runWorkflow。已补入 `dev-docs/experience/acceptance-agent-prompt-not-hermetic.md` 复发记录，密闭化修正随下一批脚本改动统一处理。

## 2. 证据

- journal 落盘：`.journal/p0a-deep-parent-*.json`、`.journal/p0a-deep-chain-*.json`、`.journal/p0a-self-ref-reject-*.json`（早期 runId 前缀为 `p0a-`，runner 现已按阶段输出 `p0b-`）、`.journal/p0b-error-propagation-1794651216242.json`
- stdout 全量日志：`.journal/p0b-deep-stdout.log`
- 关键事实核对：deep-parent journal 中 child 层 agent（prompt"深层任务"）真实模型回复正常落盘，含 sessionId/hash；self-ref 的首个 agent 执行完成后才触发自环拒绝（拒绝发生在 `workflow('./self_ref.js')` 调用点，符合"允许 agent、禁止自环 workflow"契约）。

## 3. 验收中的发现

0. **独立复验通过（2026-11-14 18:07）**：另一会话仅筛 `deep` 两用例复跑，2/2 PASS（deep-parent 2 agents 266.3s、deep-chain 3 agents 6.8s），journal `p0a-deep-parent-1794650564630.json`、`p0a-deep-chain-1794650830938.json` 落盘。deep-parent 耗时膨胀至 266s 的原因已查明：`深层任务` 子代理把泛化提示词当成编码任务，在本轮运行内部嵌套自执行了验收（warmup + 3 用例 + 更新本报告），属**验收用例不密闭**问题，完整分析与修正建议见 `dev-docs/experience/acceptance-agent-prompt-not-hermetic.md`。复验同时确认：编排语义（两层/三层 `workflow()` 嵌套、brief 传回、各层 agent ok）不受影响。

1. **runner 标题文案滞后**：`run-acceptance.ts` 汇总标题仍为"P0-A 验收"，跑 P0-B 用例时标题未区分（纯文案瑕疵，不影响断言与结果；P0-B 剩余用例验收时顺手修正）。
2. **runId 前缀统一为 `p0a-`**：runner 未按阶段区分 runId 前缀，检索 journal 时需按脚本 key 而非前缀过滤。
3. **自环拒绝耗时 57.9s 偏长**：因为自环检测发生在 child 首个 agent 之后（脚本先 `await agent('第一步')`），真实模型自由探索花费了时间；检测本身是同步查祖先链，逻辑耗时忽略不计。语义正确。

## 4. P0-B 剩余待验收（9 个）

- `mutate_parent`（产物防篡改）、`registry_parent`（按名寻址）、`compare_parent`（并行对比）
- `composite/` sequence 系：`seq_parent`、`seq_fail_parent`、`seq_parallel_parent`、`par_child_fail_parent`、`failure-gate-test`、`queue-timer-test`
- race/fallback 系归 M2
- 批量命令：`npx tsx dev-examples/sample-project-acceptance/run-acceptance.ts mutate registry compare composite par-child failure-gate queue-timer`

## 5. 产物

- 复跑命令：`npx tsx dev-examples/sample-project-acceptance/run-acceptance.ts deep self`
- 看门狗：后台 PID 记录 `/tmp/p0b-deep.pid`，轮询 `kill -0` 检活，全程未触发超时（总耗时约 100s）
