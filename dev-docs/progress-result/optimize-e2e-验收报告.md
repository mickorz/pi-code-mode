# Optimize 端到端验收报告（O0-O3）

- 日期：2026-11-23
- 目的：在真实 workflow 上验证 `optimize → benchmark → ready → apply → rollback` 全链路
- 被测对象：`dev-examples/apply-e2e/worker.js`（真实 workflow，故意带 `RETRY-001`，单轮 ~2s）
- 驱动：`dev-examples/apply-e2e-run.ts`

---

## 一、结论

**链路通了**，四步全部按设计执行，且安全不变量生效：

```text
① optimize  → 生成候选（2 处补丁→1 处实际改动），状态 benchmark-pending
② benchmark → 复用已有候选，真跑 before/after，verifier 真执行 → ready
③ apply     → 备份 + 原子写 + 重分析，hash 变化，状态 applied
④ rollback  → 从备份恢复，hash 回到原值，状态 rolled-back
```

同时**发现一个新的重要局限**（见第四节）：单次 before/after 对比无法区分真实改善与模型响应噪声。

---

## 二、实测输出

### ① optimize

```text
[优化候选待验证] opt-20261123-001
问题簇：RETRY-001
修改：1 个文件 / 2 处补丁
静态：1 条 → 0 条（目标规则已解决）
补丁审查：approve（2 项发现）
原文件未修改。
- 耗时：静态 0s + AI 复核 77s（big 档，RETRY-001）
- 未运行真实 Benchmark：当前只有静态与 AI 复核证据，**不能写回生产文件**。

会话：opt-20261123-001 | 状态：benchmark-pending
```

### ② benchmark（复用同一候选）

```text
[info] 复用候选 opt-20261123-001（状态 benchmark-pending）跑真实 Benchmark…

运行真实 Benchmark：
  before：生产目录 .../apply-e2e（**会在真实目录执行一次 workflow**）
  after ：隔离工作区 .../opt-20261123-001/workspace
  args  ：{"n":1}

[验证通过，可写回] opt-20261123-001

- 结论：**通过**（有改善且质量未降级）
- 质量门：pass（verifier 通过：node verify.mjs）

| 指标 | before | after | 改善 |
| --- | ---: | ---: | ---: |
| durationMs | 2649 | 1159 | 56.2% |
| inputTokens | 47 | 45 | 4.3% |
| agents | 1 | 1 | 0.0% |
| failedAgents | 0 | 0 | — |
```

### ③ apply

```text
[已写回] opt-20261123-001
修改文件：1 个
- worker.js
应用后重分析：1 条 finding（已落盘 applied.report.md）
备份：.../backup/manifest.json

apply 后 hash：sha256:214a5fc7...
原    始 hash：sha256:da790bd1...
已修改：true
session：applied
```

### ④ rollback

```text
[已回滚] opt-20261123-001
恢复文件：1 个
- worker.js
回滚后重分析：1 条 finding

rollback 后 hash：sha256:da790bd1...
已还原：true
session：rolled-back
```

---

## 三、验收要点逐项确认

| 验证点 | 结果 | 证据 |
| --- | --- | --- |
| 生成候选不修改原文件 | ✅ | optimize 后原 hash 未变 |
| 补丁结构校验 | ✅ | `patchSchema: pass` |
| 补丁审查 | ✅ | approve + 2 项发现 |
| **benchmark 能作用于已有候选** | ✅ | 日志明确「复用候选 opt-...-001」 |
| verifier 真执行 | ✅ | `verifier 通过：node verify.mjs`，非 stub |
| 指标按本次 runId 取 | ✅ | agents=1 / failedAgents=0 与实际一致 |
| before 生产副作用提示 | ✅ | 执行前明确警告「会在真实目录执行一次」 |
| ready 闸门生效 | ✅ | benchmark 通过后状态才变 ready |
| apply 备份 manifest | ✅ | `backup/manifest.json` 存在 |
| apply 原子写 | ✅ | hash 变化且文件完整可解析 |
| apply 后重分析 | ✅ | `applied.report.md` 落盘 |
| rollback 恢复 | ✅ | hash 与原值完全一致 |
| rollback 状态机 | ✅ | applied → rolled-back |

---

## 四、发现的重要局限：单次对比无法区分噪声

### 现象

benchmark 报告 `durationMs 2649 → 1159（改善 56.2%）`。

但这个 56% **不是补丁带来的**：

- 补丁只删了 `retries: 2`（改成缺省 1 次重试）；
- before / after 都走**成功路径**（1 个 agent，0 失败）；
- **retries 不影响成功路径耗时**；
- 1890ms 的差异来自模型响应波动。

### 为什么这是问题

`runRealBenchmark` 用「至少一项指标改善 ≥5%」判定 accepted。模型单次响应波动常在 ±50%，远大于 5% 阈值。

后果：

```text
一个毫无效果的补丁，可能因为 after 那轮模型恰好快 → 判定"改善 50%"
→ accepted → ready → 被 apply 到生产
```

本次 56% 就是活生生的例子——如果没有人工核对补丁语义，会误以为"优化很成功"。

### 建议改进（未实施，需权衡成本）

| 方案 | 成本 | 效果 |
| --- | --- | --- |
| `--benchmark-runs N` 多次采样取中位数 | 时间 × N（本项目 2s 流程可接受） | 显著降低噪声误判 |
| 只认「结构性指标」改善（agents / failedAgents / inputTokens），忽略 durationMs | 无额外成本 | durationMs 噪声最大，结构性指标更确定 |
| 要求改善幅度 ≥ 噪声带（如 3× 历史标准差） | 需要基线数据 | 最严谨，但要先有历史样本 |

**短期最实用的组合**：`--benchmark-runs 3` 取中位数 + 关键判定优先看 `agents`/`failedAgents`。

### 当前的诚实表述

本次 apply 虽然"通过"了所有闸门，但**收益未被真实证明**：

- 补丁本身是正确的（移除确定性任务的重试是合理优化）
- 但 56% 的耗时代价数字不可信
- 真正的收益应该体现在**失败场景**（最坏调用量 3 → 1），而本次没有构造失败场景

---

## 五、附加发现：功能断裂已修

跑端到端前发现：`--benchmark` **无法作用于已有候选**。

```text
第一次 optimize → 建会话 A，状态 benchmark-pending
第二次 optimize <target> --benchmark → 命中 findOpenSession → 只提示"继续处理该候选"就 return
加 --fresh → 新建会话 B（丢掉 A 已生成的补丁）
```

即 benchmark 路径实际不可达，`apply` 永远到不了 `ready`。

**已修**：抽出 `benchmarkSession()`，并在 `runOptimize` 开头加分支——有未完成会话且带 `--benchmark` 时复用该会话跑验证。这也顺带消除了内联 benchmark 代码的重复。

---

## 六、复现方法

```bash
# 单次跑完整链路（约 3~5 分钟，含 big 档 AI 复核 77s）
npx tsx dev-examples/apply-e2e-run.ts
```

产物：

```text
dev-examples/apply-e2e/.pi/workflows/optimizations/opt-*/review.md
  benchmark.md          含指标对比与 verifier 输出
  patchset.json         补丁内容
  workspace/            隔离工作区
  backup/manifest.json  apply 时创建
  applied.report.md     apply 后重分析
  rolledback.report.md  rollback 后重分析
```

---

## 七、结论与下一步

**可以说的话**：

- O0-O3 链路可用，安全不变量（备份、hash 校验、原子写、状态门）全部生效
- verifier 真执行、benchmark 按 runId 取数、rollback hash 一致 都有实测证据

**不能说**：

- "benchmark 证明了优化有效" —— 单次对比不能证明，本次 56% 是噪声

**下一步优先级**：

1. `--benchmark-runs N` 多次采样（解决噪声误判，这是当前最影响可信度的问题）
2. 失败场景验证：`RETRY-001` 的收益只在失败路径体现，应支持注入失败用例
3. 真实生产 workflow 端到端（`game-requirement-audit`，成本 1~2 小时）

---

## 引用

- 被测 workflow：`dev-examples/apply-e2e/worker.js`
- verifier：`dev-examples/apply-e2e/verify.mjs`
- 驱动：`dev-examples/apply-e2e-run.ts`
- 实现：`extensions/commands/workflows/optimize/index.ts`、`src/engine/optimizer/*`
- 评审报告：`dev-docs/troubleshooting/2026-11-23-optimize-o0-o3-review.md`
- 执行计划：`dev-docs/planning/2026-11-20-workflow-optimize-execution-plan.md`
