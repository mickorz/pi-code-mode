# Workflow Plan（执行计划文件）

pi-code-mode 的 Workflow 由两个独立产物组成：

```
workflow.js        ← 业务逻辑（控制流、数据处理、prompt）
workflow.plan.json ← 执行策略（stages、quality、profiles）
```

## 为什么分开

- 改模型/预算/并发策略**不用重写业务脚本**
- Plan 可独立审核、独立版本管理
- 同一份 JS 可用不同 Profile 跑（fast / balanced / quality）

## 文件位置（按优先级）

1. `<script>.plan.json`（脚本同级）
2. `<script-name>.plan.json`（脚本同级，短名）
3. `.pi/workflows/plans/<script-name>.plan.json`

没有 Plan 的旧 Workflow **照常运行**——Analyzer 只会建议创建。

## 结构

```json
{
  "planVersion": "1.0",
  "planHash": "sha256:…",
  "workflowId": "demo_flow",
  "name": "演示流程",
  "source": {
    "scriptPath": ".pi/workflows/demo.js",
    "scriptHash": "sha256:…",
    "analyzedAt": "2026-11-18"
  },
  "definition": {
    "stages": [
      { "id": "scan", "type": "parallel", "estimatedAgents": 8 },
      { "id": "review", "type": "parallel", "dependsOn": ["scan"] },
      { "id": "summary", "type": "sequential", "dependsOn": ["review"] }
    ],
    "quality": {
      "requiredValidation": true,
      "acceptanceCriteria": ["所有分片均有处理结果"]
    }
  },
  "profiles": {
    "fast": { "mode": "fast", "concurrency": { "max": 8 } },
    "balanced": { "mode": "balanced", "concurrency": { "max": 4 }, "budget": { "maxAgents": 20 } },
    "quality": { "mode": "balanced", "additionalValidation": ["交叉评审"] }
  }
}
```

## Definition vs Profile

| 归属 | 内容 | 规则 |
| --- | --- | --- |
| **definition** | stages 结构、quality 强制项 | 只有一份；Profile 不得覆盖 `stages` / `requiredValidation` / `acceptanceCriteria` |
| **profiles** | fast / balanced / quality 的差异化执行策略（mode/concurrency/modelPolicy/budget/additionalValidation） | 只存差异；未声明字段回退默认值 |

**默认 Profile 是 `balanced`**。Profile 可以**追加**验证，**不能关闭** Definition 的强制验证（`Effective Validation = Required Validation ∪ Profile Validation`）。

## 指纹

| 字段 | 含义 | 参与 planHash |
| --- | --- | --- |
| `source.scriptHash` | 脚本内容指纹（检测 Plan 是否过期） | ✅ |
| `source.analyzedAt` | 分析时间（报告元数据） | ❌ |
| `planHash` | Plan 内容指纹 | ❌（防自引用） |
| `planVersion` | Plan Schema 版本 | ✅ |

计算规则：`planHash = SHA256(canonicalJSON(Plan without planHash))`（剔除 `planHash` 与 `source.analyzedAt`，键序无关）。

`WorkflowRunConfig`（run 级，由 M2 Plan Runner 组合生成）：

```json
{ "workflowId": "demo_flow", "runId": "run-xxx", "planHash": "sha256:…", "activeProfile": "balanced", "profileHash": "sha256:…" }
```

## 校验规则（Plan Validator）

- 必填：`planVersion` / `source` / `definition.stages` / `definition.quality.requiredValidation` / `profiles`
- stage `type` ∈ {parallel, sequential, dynamic}；`dependsOn` 必须指向已声明 stage
- Profile 内出现 `requiredValidation` / `stages` / `acceptanceCriteria` → 报错
- `source.scriptHash` 与当前脚本不一致 → **Plan 过期**（需重新分析）
- 错误全部带可定位路径（如 `profiles.fast.requiredValidation`）

## 生命周期

Created → Analyzed → Approved → Executed → Evaluated → Optimized

M1 覆盖 Created + Analyzed（Analyzer 检查）；执行消费（Executed）在 M2。
