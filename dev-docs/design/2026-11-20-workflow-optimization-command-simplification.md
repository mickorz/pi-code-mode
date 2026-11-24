# Workflow Optimize 命令第一性原理简化方案

- 日期：2026-11-20
- 关联设计：`dev-docs/design/2026-11-20-workflow-optimization-lifecycle-design.md`
- 结论：原先 6 条命令把**内部生命周期**暴露给了用户。用户真正只关心两件事：**生成可审阅的优化方案**、**确认是否应用**。应收敛为一个主命令和两个最小的后续动作。

---

## 一、第一性原理

优化 Workflow JS 的目的不是让用户操作状态机，而是回答：

1. **哪些问题值得改，改什么？**
2. **改完有没有真的更好，是否安全？**
3. **我是否同意把经过验证的修改写回原文件？**

原始命令：

```text
start / status / review / benchmark / apply / discard
```

暴露的是实现步骤：创建会话、查状态、看 diff、跑基准、写回、清理。

其中：

| 原命令 | 是否是用户独立意图 | 正确处理 |
| --- | --- | --- |
| `start` | 是 | 保留为主命令，但去掉 `start` 子命令 |
| `status` | 否 | 主命令的结果中已经显示状态；恢复会话时自动显示 |
| `review` | 否 | `optimize` 完成时自动展示/落盘 review 摘要 |
| `benchmark` | 否 | 优化候选生成后自动执行（或明确标 `待执行`） |
| `apply` | 是 | 保留，必须显式授权 |
| `discard` | 否 | 默认保留审计记录，临时工作区自动清理；需要清理时由 `apply --discard` 或内部 TTL 完成 |

结论：**用户命令不该反映引擎的阶段数。**

---

## 二、收敛后的命令设计

```text
/workflows optimize <file-or-dir> [--rules <rule-id,...>] [--tier <tier>]
/workflows optimize apply <optimization-id>
/workflows optimize rollback <optimization-id>
```

### 2.1 主命令：`optimize <target>`

取代原：

```text
optimize start
optimize review
optimize benchmark
optimize status
```

一次调用自动完成：

```text
分析 → 选定问题簇 → 生成 PatchSet → 隔离工作区应用
  → 静态 / AI Rule Check → before/after Benchmark → 生成 Review
```

结果只给用户一个清晰结论：

```text
[优化候选已就绪] opt-20261120-001

目标：game-requirement-audit/
修改：2 个文件 / 3 处最小补丁
解决：REC-002（恢复集合未传递）、IO-001（确定性回读）

验证：
  静态：37 条 → 25 条
  AI Rule Check：REC-002 hit → pass
  Benchmark：耗时 -18% / token -12% / Required Validation 全通过

尚未修改原文件。
详情：.pi/workflows/optimizations/opt-20261120-001/review.md

确认写回：/workflows optimize apply opt-20261120-001
```

如果无法真实 Benchmark：

```text
[优化候选待验证] opt-20261120-001

静态验证已通过，但没有可用的真实执行验证器；原文件未修改。
需要补充验证命令/Plan Required Validation 后重新运行 optimize。
```

这比让用户自己想“下一步该跑 review 还是 benchmark”更符合产品目标。

### 2.2 应用：`optimize apply <id>`

唯一允许修改原版 Workflow JS 的命令。

自动完成：

```text
检查 review 后源文件 hash
  → 备份原文件
  → 原子写回
  → 应用后重新 anal
  → 记录基线与优化审计
```

若 source hash 已变：

```text
[拒绝应用] 原文件在 review 后发生变化。
请重新运行：/workflows optimize <target>
```

不需要额外 `--approve`：**用户输入 `apply` 本身就是明确授权**。

### 2.3 回滚：`optimize rollback <id>`

保留是因为“写回后恢复原版”是一个真实、独立、不可自动发生的用户意图。

```text
/workflows optimize rollback opt-20261120-001
```

自动从该会话的 backup manifest 恢复，之后重新 `anal`，但仍要求一次确认。

---

## 三、被隐藏的内部生命周期

用户不再操作这些阶段，但它们仍保留为可审计状态：

```text
created
  → proposed
  → patched
  → verified
  → benchmarked
  → ready
  → applied
  ↘ rejected / stale / failed
```

展示位置：

- `optimize <target>` 的最终摘要
- Dashboard 的“优化候选”卡片
- `.pi/workflows/optimizations/<id>/session.json`
- `review.md`

无需单独 `status` 命令；用户重复运行：

```text
/workflows optimize <same-target>
```

系统自动查找该 target 最近未终态会话，提示：

```text
发现未完成优化候选 opt-20261120-001（已完成静态验证，待 Benchmark）。
继续验证该候选，或用 --fresh 创建新候选？
```

默认继续已有候选；`--fresh` 才明确重新生成。

---

## 四、`--rules` 的保留理由

`--rules REC-002,IO-001` 不是生命周期泄露，是**优化范围**。

保留，但支持不写：

```text
/workflows optimize <target>
```

默认策略：

1. 只选择可自动生成安全补丁的规则（初期：`DET-001`、有限的 `IO-001`、`REC-002`）
2. 排除默认不能自动改的规则（`SERIAL-002`、`CONC-002`、`SIDEFX-001`、`BUDGET-001`）
3. 若没有安全候选，输出原因与人工动作，而不是生成空会话

显式 `--rules` 的意义：用户想优先处理一个已知问题簇。

---

## 五、命令帮助建议

```text
/workflows optimize <路径|目录> [--rules ID,ID] [--tier fast] [--fresh]
  生成并验证候选优化；不会修改原文件。

/workflows optimize apply <优化编号>
  将已验证候选原子写回原文件（自动备份、重分析）。

/workflows optimize rollback <优化编号>
  从该候选备份恢复原文件（需确认）。
```

不向普通用户展示：

```text
status / review / benchmark / discard
```

如需调试，内部可保留开发专用工具或 JSON 状态文件，不做公开产品命令。

---

## 六、状态与失败处理

| 情况 | 主命令输出 | 用户下一步 |
| --- | --- | --- |
| Patch 生成失败 | AI 无法给出最小安全补丁，原文件未改 | 修规则/手动优化 |
| 静态验证失败 | 候选已拒绝，附 diff 与失败规则 | 不可 apply |
| Benchmark 不可用 | 候选待验证，原文件未改 | 补 verifier/Plan 后重新 optimize |
| Benchmark 无收益 | 候选已拒绝，保留审计记录 | 不可 apply |
| 质量下降 | 候选已拒绝，保留 diff | 不可 apply |
| 验证通过 | 候选已就绪 | `optimize apply <id>` |
| apply 时 hash 变化 | stale，拒绝写回 | 重新 `optimize <target>` |

---

## 七、与备份策略的关系

主命令全过程在隔离工作区运行，原文件零写入。

只有：

```text
/workflows optimize apply <id>
```

才会：

```text
检查源 hash → backup manifest → writeFileAtomic → 应用后 anal → 基线归档
```

回滚是显式命令，不自动回滚，避免隐藏应用后的真实状态。

---

## 八、实施调整

原 O0~O3 计划不变，只改用户层命令：

| 原设计 | 简化后 |
| --- | --- |
| `optimize start` | `optimize <target>` |
| `optimize status` | 自动显示 / session.json |
| `optimize review` | 主命令自动生成 review.md + 摘要 |
| `optimize benchmark` | 主命令自动跑，不能跑则明确 pending |
| `optimize apply` | 保留 |
| `optimize discard` | 隐藏；TTL 自动清理临时 workspace，审计记录保留 |
| 无 rollback | 新增 `optimize rollback` |

因此最终公开命令数从 **6 条降为 3 条**，其中日常使用只需记住 **1 条**：

```text
/workflows optimize <target>
```

---

## 九、未决事项

在开始 Patch Generator 前，仍需按 `CLAUDE.md` 的模型档位规范确认：

| 调用点 | 推荐 | 原因 |
| --- | --- | --- |
| Patch Generator | `big` | 生成生产 JS 修改，正确性优先 |
| Patch Reviewer | `fast` | 按约束审查 diff，速度优先 |

确认后再实施 O1，不能自行默认。

---

## 引用

- 完整生命周期：`dev-docs/design/2026-11-20-workflow-optimization-lifecycle-design.md`
- 当前优化半成品：`src/engine/evaluator/optimization-loop.ts`
- Benchmark：`src/engine/evaluator/benchmark-runner.ts`
- Patch/模型档位规范：`CLAUDE.md`「大模型调用规范（强制）」
