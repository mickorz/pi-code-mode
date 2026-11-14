# P0-B 验收进度（子工作流与 sequence）

> 状态：**基础设施就绪，验收暂缓**——当前模型通道并发配额低，真实模型验收待换新模型后统一执行（用户决策 2026-11-14）。

## 已完成

1. **脚本副本自包含改写**：`B-subworkflows/native/*.js` 内 `./scripts/native/` → `./`；`composite/*.js` → `../native/`（副本相对路径自包含，不再依赖 sample-project 目录结构）。
2. **registry 验收结构**：`B-subworkflows/registry/.opencode-workflows/workflows/schedule-test.js` + `registry_parent.js`——引擎按名寻址扫描 `<cwd>/.opencode-workflows/workflows/`（M1 兼容旧目录约定），cwd 指向 registry/ 即可命中。
3. **runner 扩展**（`run-acceptance.ts`）：
   - 新增 `failureAssert` 机制：预期失败用例（self-ref 自环拒绝、failure-gate 阶段闸门）以错误消息正则判定 PASS
   - 新增 13 个 P0-B case 定义（见下表），filter 修复为覆盖全部 case
4. **单项验证**：`native-pipeline` PASS（3 agents，36.4s，spec→design→code prev 传递正确）。

## 待执行清单（新模型通道就绪后）

| key | 脚本 | 预期 |
|---|---|---|
| deep-parent | deep_parent.js | root→child→spec 两层嵌套成功 |
| deep-chain | deep_chain_parent.js | 三层链全部执行 |
| self-ref-reject | self_ref_parent.js | **预期失败**：错误含「自环/祖先」 |
| error-propagation | error_parent.js | child throw 被父 catch（caught=true） |
| registry-byname | registry/registry_parent.js | 按名 schedule_test 寻址成功 |
| compare-parallel | compare_parent.js | 同脚本三实例并行，brief 互不相同 |
| composite-seq | seq_parent.js | sequence 三段 prev 链 |
| composite-seq-fail | seq_fail_parent.js | 失败立即停止返回 null，seen=[a,b]，after=STOP-CHECK |
| composite-seq-parallel | seq_parallel_parent.js | sequence 内组合 parallel，保序 |
| par-child-fail-collapse | par_child_fail_parent.js | child 失败塌缩 null，兄弟照常 |
| failure-gate | failure-gate-test.js | **预期失败**：WORKFLOW_FAILED「阶段失败闸门」+ 1ms 超时注入 |
| queue-timer | queue-timer-test.js | concurrency=2 下 4 agent 排队完成 |

执行命令：`npx tsx dev-examples/sample-project-acceptance/run-acceptance.ts deep self-ref error-prop registry compare composite par-child failure-gate queue-timer`

## 验收语义备注

- 两个「预期失败」用例是引擎安全语义的正向验收（自环拒绝、失败闸门必须可靠触发），PASS 判据是错误消息命中而非执行成功。
- failure-gate 用 `timeoutMs: 1, retries: 0` 做确定性失败注入（不依赖模型行为），任何通道下语义一致。
- M2 归属的脚本（race/fallback/resume/mutate/seq_resume 变体）不在本表，随 M2 里程碑验收。
