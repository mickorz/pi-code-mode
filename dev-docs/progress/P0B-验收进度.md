# P0-B 验收进度（子工作流与 sequence）

> 状态：**验收进行中**——模型通道可用（glm-5.3-flash，warmup 1.6s ok），已完成 **5/14** 用例，剩余 9 个待统一执行。

## 已完成

1. **脚本副本自包含改写**：`B-subworkflows/native/*.js` 内 `./scripts/native/` → `./`；`composite/*.js` → `../native/`（副本相对路径自包含，不再依赖 sample-project 目录结构）。
2. **registry 验收结构**：`B-subworkflows/registry/.opencode-workflows/workflows/schedule-test.js` + `registry_parent.js`——引擎按名寻址扫描 `<cwd>/.opencode-workflows/workflows/`（M1 兼容旧目录约定），cwd 指向 registry/ 即可命中。
3. **runner 扩展**（`run-acceptance.ts`）：
   - `failureAssert` 机制：预期失败用例（self-ref 自环拒绝、failure-gate 阶段闸门）以错误消息正则判定 PASS
   - 14 个 P0-B case 定义，filter 覆盖全部 case；runId 前缀按 `P0B_CASES` 区分输出 `p0b-`
4. **已通过用例（5）**：

| key | 耗时 | 结果 |
|---|---|---|
| native-pipeline | 36.4s | PASS（3 agents，spec→design→code prev 传递正确） |
| deep-parent | 33.4s（复验 266.3s） | PASS（两层嵌套；复验耗时膨胀系提示词不密闭，见 experience） |
| deep-chain | 7.4s | PASS（三层链 root→l2→l3） |
| self-ref-reject | 57.9s | PASS（预期失败：自环拒绝错误消息命中） |
| error-propagation | 58.3s | PASS（child throw 被父 try-catch 捕获，caught=true 且 message 含「产物闸门」；journal `p0b-error-propagation-1794651216242.json`） |

## 待执行清单（9 个）

| key | 脚本 | 预期 |
|---|---|---|
| mutate-args-isolation | mutate_parent.js | args 克隆隔离：child 内 999/injected 改动不外溢父层 |
| registry-byname | registry/registry_parent.js | 按名 schedule_test 寻址成功 |
| compare-parallel | compare_parent.js | 同脚本三实例并行，brief 互不相同 |
| composite-seq | seq_parent.js | sequence 三段 prev 链传递 |
| composite-seq-fail | seq_fail_parent.js | 失败立即停止返回 null，seen=[a,b]，after=STOP-CHECK |
| composite-seq-parallel | seq_parallel_parent.js | sequence 内组合 parallel，两实例并发保序 |
| par-child-fail-collapse | par_child_fail_parent.js | child 失败塌缩 null，兄弟分支照常 |
| failure-gate | failure-gate-test.js | **预期失败**：WORKFLOW_FAILED「阶段失败闸门」+ 1ms 超时注入 |
| queue-timer | queue-timer-test.js | concurrency=2 下 4 agent 排队完成 |

执行命令：`npx tsx dev-examples/sample-project-acceptance/run-acceptance.ts mutate registry compare composite par-child failure-gate queue-timer`

## 验收语义备注

- 「预期失败」用例（self-ref-reject、failure-gate）是引擎安全语义的正向验收，PASS 判据是错误消息命中而非执行成功。
- failure-gate 用 `timeoutMs: 1, retries: 0` 做确定性失败注入（不依赖模型行为），任何通道下语义一致。
- **提示词密闭化欠账**：`deep_child.js`（`深层任务`）、`error_child.js`（`检查产物闸门`）的自由 agent 提示词会诱发子代理自执行仓库任务（后者已复发一次），见 `dev-docs/experience/acceptance-agent-prompt-not-hermetic.md`，随下一批脚本改动统一改为纯生成提示词。
- M2 归属的脚本（race/fallback/resume 变体、seq_resume 变体）不在本表，随 M2 里程碑验收。
