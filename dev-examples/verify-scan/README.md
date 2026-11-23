# 1-scan-template.js 质量门 verifier

供 `/workflows optimize ... --benchmark --verify-cmd "node dev-examples/verify-scan/verify-scan-template.mjs"` 使用。

## 为什么需要它

`optimize apply` 的硬闸门是「有真实 Benchmark 且质量门通过」。没有 verifier 时
quality 恒为 `unavailable`，会话永远停在 `benchmark-pending`，无法 apply。

## 它校验三层

| 层 | 内容 |
| --- | --- |
| A schema | `scan.json` 必填字段、类型、`kind` 枚举、行号整数且 from<=to |
| B 不变量 | 首节 fromLine=1、末节 toLine=totalLines、行号单调不重叠、间隙 ≤2 行、intro/terms 各至多一个、`stageId` 从 `ST-C01` 连续、`no` 从 1 连续 |
| C 等价性 | after 与 before 的 `scan.json` **逐字段一致**（忽略 generatedAt 等易变字段） |

C 是关键：`RETRY-001` 的改动语义上不该改变产物。**产物不一致 = 行为变了**，
无论耗时是否下降都不算优化成功。

## 环境变量（optimize 自动注入）

```
PI_OPT_PROJECT_ROOT  项目根
PI_OPT_BEFORE_RUN    before 轮的 runDir（相对项目根）
PI_OPT_AFTER_RUN     after  轮的 runDir
```

optimize 的 benchmark 会自动给 `--args` 里的 `runDir` 追加 `-before` / `-after`，
隔离两次产物，并把这两个路径注入给 verifier。

## 已验证的判断能力

| 场景 | 结果 |
| --- | --- |
| before/after 一致 | 通过 |
| after 改了章节标题 | 失败（指出 `sections[2].title` 差异） |
| 行号断裂（中间漏 5 行） | 失败（指出未覆盖 + 字段差异） |
| stageId 断号 | 失败（期望 ST-C02 实际 ST-C05） |
