# Optimize O0-O3 实现评审报告

- 日期：2026-11-23
- 评审对象：最近实现的 `/workflows optimize` O0-O3（会话、PatchSet、隔离工作区、Benchmark、apply、rollback）
- 范围：
  - `extensions/commands/workflows/optimize/index.ts`
  - `src/engine/optimizer/*.ts`
  - `tests/optimizer/*.test.ts`
  - `package.json` 测试脚本
- 方法：代码走读 + 安全不变量反查 + 独立只读审计 + 已有端到端运行结果复核
- 结论：**O0/O1 的「分析 → 候选 → 隔离工作区 → 审查」方向正确，且真实运行能拒绝不安全补丁；但 O2/O3 尚不满足生产写回条件。`optimize apply` 必须暂时保持禁用，直到 P0 问题全部修复。**

---

## 一、总体评价

### 做对的部分

| 能力 | 评审结论 | 证据 |
| --- | --- | --- |
| 用户命令面 | 合理 | 已从内部生命周期收敛为 `optimize / apply / rollback` |
| 隔离工作区 | 正确 | `workspace.ts` 复制目标目录文本树，排除 `.git/node_modules/dist/thirdparties/.pi` |
| PatchSet | 方向正确 | 结构化 edit、路径白名单、行号范围、JS parse、`export const meta` 守卫 |
| 源文件保护 | 正确 | optimize 阶段工作区写入，生产文件 hash 检查 |
| 备份 / rollback 模型 | 方向正确 | backup manifest、原子写、漂移文件默认拒绝覆盖 |
| Reviewer | 有实际价值 | REC-002 真实审查发现“主编排虽传 impactSet，但 S4/S5 消费端根本不读”的跨文件盲区 |
| 无 Benchmark 禁 apply | 设计正确 | session 保持 `benchmark-pending` 时 apply 拒绝 |

### 当前不能放开的部分

```text
真实 verifier 没有执行，却会返回 quality=pass
→ Benchmark 可能 accepted
→ session 可能 ready
→ apply 可能写生产文件
```

这是直接违反 O2 的硬规则「无质量门不得 apply」，必须先修。

---

## 二、P0：必须在开放 apply 前修复

### P0-1：`--verify-cmd` 当前是假执行，可能让未验证补丁写入生产文件

**位置**：`extensions/commands/workflows/optimize/index.ts:584-586`

当前代码：

```ts
...(verifierCmd
  ? {
      runVerifier: async (cmd: string) => ({
        ok: true,
        output: `verifier 已配置但未执行：${cmd}（O2 首版仅接受 shell 退出码，需在后续接入）`,
      }),
    }
  : {})
```

### 为什么严重

`runVerifier` 无条件返回 `ok: true`。下游 `runRealBenchmark()` 会把质量门记为 `pass`。只要 after 恰好有 ≥5% 指标改善，session 就可能从 `benchmark-pending` 升为 `ready`，随后 `apply` 放行。

用户以为执行了：

```text
--verify-cmd "npm test"
```

实际该命令**从未执行**。

### 修复要求

1. 用 `execFile` 或受限 shell 真正执行 verifier。
2. cwd 必须是 after 工作区（不能在生产目录执行）。
3. 保存 stdout / stderr / exit code 到 `benchmark.json`。
4. 超时必须失败，不能返回 `ok: true`。
5. 在真执行接线前：传 `--verify-cmd` 应明确拒绝或视为 `qualityGate=none`，绝不能假通过。

### 验收用例

| verifier | 预期 |
| --- | --- |
| `node -e "process.exit(0)"` | quality=pass |
| `node -e "process.exit(1)"` | quality=fail，session=rejected |
| 不存在的命令 | quality=fail |
| 超时命令 | quality=fail |

---

### P0-2：Patch validator 声称按行号修改，实际仍按内容的第一次出现替换

**位置**：`src/engine/optimizer/patch-validator.ts:98-115` 与 `:168-172`

当前核心代码：

```ts
const sliced = originalLines.slice(edit.startLine - 1, edit.endLine).join("\n")
const occurrences = patched.split(sliced).length - 1
if (occurrences === 0) { ... }
patched = patched.replace(sliced, edit.newText)
```

### 为什么严重

`String.replace()` 只替换**第一次出现**。若行号指定的代码片段在文件前面已有完全相同的片段：

- validator 只检查 `occurrences === 0`，不拒绝 `occurrences > 1`。
- 实际替换的是第一次出现，不一定是行号指向的位置。
- parse、meta、行数检查都可能通过。
- 结果是改了无关代码，但报告显示 patch 通过。

行号定位在这种实现下只是“生成 sliced 字符串”，并不真正控制替换位置。

### 修复要求

不要使用字符串 replace。使用行数组按 edit 区间倒序 splice：

```ts
const lines = original.split("\n")
for (const edit of editsByStartLineDesc) {
  lines.splice(
    edit.startLine - 1,
    edit.endLine - edit.startLine + 1,
    ...edit.newText.split("\n"),
  )
}
const patched = lines.join("\n")
```

这样 `startLine/endLine` 才是唯一写入位置；`oldText` 只作为额外一致性校验，不能作为写入定位。

---

### P0-3：优化安全测试没有进入 package.json 的任何标准测试脚本

**位置**：`package.json`

当前只有：

```json
{
  "test:engine": "tsx --test tests/engine/*.test.ts",
  "test:contract": "tsx --test tests/contract/*.test.ts"
}
```

但下列安全测试从默认 CI / 开发流程中不会运行：

```text
tests/optimizer/patch-validator.test.ts
tests/optimizer/benchmark-adapter.test.ts
tests/optimizer/apply-service.test.ts
```

### 修复要求

至少新增：

```json
"test:optimizer": "tsx --test tests/optimizer/*.test.ts"
```

并新增总入口：

```json
"test": "npm run test:engine && npm run test:contract && npm run test:optimizer && npm run test:analyzer"
```

`npm run build` 后的 O2/O3 变更必须跑 `test:optimizer`。

---

### P0-4：Benchmark 指标可能取自无关 run

**位置**：`extensions/commands/workflows/optimize/index.ts:563-565`

```ts
const runs = deps.runManager.list()
const latest = runs[0]
const detail = latest ? deps.runManager.status(latest.runId) : undefined
```

### 为什么严重

`RunManager.list()` 并不保证 `runs[0]` 是刚刚 benchmark 启动的 run。并发有其他 workflow 时：

- 可能拿到老 run 的 agents/token/failedAgents。
- before/after 指标来自不同运行。
- Benchmark 的 accept/reject 建立在错误数据上。

### 修复要求

`makeWorkflowTool.execute()` 或运行适配器必须返回本次 `runId`，然后：

```ts
const detail = deps.runManager.status(runId)
```

禁止用 `list()[0]` 猜测。

---

## 三、P1：应在 O3 宣称可用前修复

### P1-1：oldText 的空白归一化正则写错

**位置**：`src/engine/optimizer/patch-validator.ts:100`

```ts
const norm = (s: string) => s.replace(/s+/g, " ").trim()
```

预期应为：

```ts
const norm = (s: string) => s.replace(/\s+/g, " ").trim()
```

当前匹配的是字母 `s`，不是空白：

- 同样代码仅缩进不同会被误拒。
- 含大量字母 s 的不同文本可能被异常归一。

---

### P1-2：newText 含 `$&` / `$'` / `$$` 会被 `String.replace` 特殊展开

**位置**：`patch-validator.ts:115、172`

```ts
patched.replace(sliced, edit.newText)
```

JS 字符串替换的第二参数中：`$&`、`$'`、`` $` ``、`$$` 有特殊含义。模型生成模板字符串、shell 内容、正则或文本时可能出现这些字符，导致 patch 内容被静默改写。

**修复**：即便临时仍用 replace，也要：

```ts
patched.replace(sliced, () => edit.newText)
```

但正确修复仍是 P0-2 的行号 splice。

---

### P1-3：before 失败仍可能作为可接受基线

**位置**：`src/engine/optimizer/benchmark-adapter.ts`

当前只拒绝：

```ts
if (!after.ok) { ... }
```

没有拒绝 `before.ok === false`。若 before 本身失败：

- 基线不可比。
- after 成功看起来会“改善”。
- 可能错误 accepted。

**修复**：

```ts
if (!before.ok) {
  accepted = false
  reasons.push("before 执行失败，基线不可比")
}
```

---

### P1-4：apply 部分写入失败时，rollback 命令反而被状态门挡住

**位置**：

- apply 失败提示：`optimize/index.ts:730`
- rollback 门：`optimize/index.ts` 的 `s.status !== "applied"`

apply 写入中途失败时，`applyToProduction()` 已有 backup，也可能已经写了一部分文件；但 session 状态仍是 `ready`。随后：

```text
/workflows optimize rollback <id>
```

会被拒绝，因为状态不是 `applied`。

### 修复要求

1. apply 部分写入失败 → session 状态显式设为 `apply-partial-failed`。
2. rollback 允许：`applied | apply-partial-failed`，前提是 backup manifest 存在。
3. review.md 必须标红“可能存在部分生产写入，立即 rollback”。

---

### P1-5：review/benchmark 通过后，workspace 内容没有 hash 绑定

**位置**：`optimize/index.ts:704-711`

apply 直接读取：

```ts
content: fs.readFileSync(wsFile, "utf8")
```

也就是说：

```text
review / benchmark 完成
→ workspace 被人工或其他进程改了
→ apply 读取被改后的内容写进生产
```

session 没有记录 “reviewed workspace file hash”。审阅与实际写回可能不是同一份内容。

### 修复要求

在 patch 应用到 workspace 后记录：

```ts
workspaceHashes: Record<string, string>
```

Benchmark / review 完成后更新为 `reviewedWorkspaceHashes`；apply 前逐文件比对。不同 → session=stale，拒绝 apply。

---

## 四、P2：产品与维护问题

| ID | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| P2-1 | `optimize/index.ts` | evidenceLines 填充循环存在重复代码/重复 push | 删除重复循环，保留一个函数抽取 |
| P2-2 | `optimize/index.ts` | 注释称“降级 fast”，实际同档 fast 重试；`usedTier` 恒等于 tier | 修正文案/删除死状态，或明确实现 tier fallback 策略 |
| P2-3 | `session-store.ts` | `writeSession` 用裸 `writeFileSync`，进程崩溃可损坏 session.json | 用 `writeFileAtomic` |
| P2-4 | `session-store.ts` | `findOpenSession` 用原始 ref 字符串比较，`./wf` 与 `wf` 会建两个会话 | session 保存 canonical root / 规范化 target key |
| P2-5 | `apply-service.ts` | backup 文件名 `a/b.js → a__b.js.bak` 可与真实 `a__b.js` 碰撞 | 保留目录层级，或在备份名加入 hash |
| P2-6 | `apply-service.ts` | 不复检 `isAllowedPatchPath`，依赖上游 validator | apply service 自己做路径白名单（纵深防御） |
| P2-7 | `workspace.ts` | 超过 MAX_FILES=2000 静默截断，验证可能不完整 | 记录 fatal/explicit warning，拒绝优化或状态 unavailable |
| P2-8 | `optimize/index.ts` | `--rules` 可显式请求 SERIAL-002/CONC-002 等不安全规则并进入自动 patch | 显式 `--unsafe-rules` 才允许，并在命令输出强提示 |
| P2-9 | `optimize/index.ts` | before benchmark 在生产目录真实跑，可能重复写产物/外部调用 | 默认要求 dry-run/sandbox args；没有隔离执行能力时显示副作用警告并要求确认 |
| P2-10 | `--args` JSON 非法 | early return 后 session 停在 patched，重复 optimize 会提示 open session | 更新 session 为 failed/rejected 并写 review 原因 |

---

## 五、测试缺口

### 当前测试的优点

`tests/optimizer/` 已覆盖大量关键单元边界：

```text
路径穿越
oldText 不一致
行号越界
edit 重叠
JS parse
meta 丢失
workspace 不写生产
stale
backup
rollback 漂移与 force
benchmark 单元结论
```

### 仍缺的测试

| 缺口 | 必须新增的用例 |
| --- | --- |
| 行号写入 | 同一 `sliced` 文本出现两次，必须只修改 startLine 指向的第二处 |
| `$` replacement | newText 含 `$&`、`$$`，写入后必须逐字一致 |
| whitespace norm | oldText 仅缩进不同，必须按约定通过；非空白不同必须拒绝 |
| hash 缺失 | `expectedSourceHash=""` 必须拒绝 |
| before fail | benchmark before.ok=false → accepted=false |
| 真 verifier | exit 0/1、命令不存在、超时各自的 session 状态 |
| runId 精确归属 | 并发两个 run，benchmark 指标只能取自己的 runId |
| workspace hash | review 后篡改 workspace → apply=stale |
| apply 部分失败 | rollback 命令能恢复而不是被状态门挡住 |
| optimize command | O0/O1/O2/O3 的编排测试，而非只测底层工具 |

---

## 六、建议修复顺序

### 第一批：立即阻断生产写回

1. P0-1：在 verifier 真执行前，禁用 `--verify-cmd` 的 pass 路径。
2. P0-2：行号 splice 替换，彻底修复错位写入。
3. P0-3：把 `tests/optimizer/*.test.ts` 接入 package scripts。
4. P0-4：runId 精确归属，禁止 `runs[0]`。

完成前：`apply` 仍可保留命令，但必须拒绝所有写回（明确说明“O3 安全修复中”）。

### 第二批：恢复与基线可信度

5. P1-1/P1-2：正则与 `$` 内容修复（若已用 splice，P1-2 自动消失）。
6. P1-3：before fail 不能作基线。
7. P1-4：apply 部分失败可 rollback。
8. P1-5：workspace hash 绑定 review / benchmark / apply。

### 第三批：清理与产品边界

9. P2 各项，特别是 workspace 超限不能静默截断。
10. 明确 `--unsafe-rules` 与 benchmark 副作用策略。

---

## 七、最终结论

当前 optimize 的**分析、候选、隔离、审查**可继续使用，特别是它在 REC-002 场景发现“传参但消费端不读”的能力很有价值。

但不能把 O3 描述为“可安全生产写回”：

```text
当前状态：O0/O1 可用；O2/O3 实现存在 P0 安全问题。
推荐状态：apply 暂停开放，先修 P0/P1 后再跑真实 ready → apply → rollback 验收。
```

在 P0-1（假 verifier）与 P0-2（错位写入）未修复前，任何 `ready → apply` 成功都不能作为安全证据。

---

## 引用

- 命令编排：`extensions/commands/workflows/optimize/index.ts`
- Patch 校验：`src/engine/optimizer/patch-validator.ts`
- Benchmark：`src/engine/optimizer/benchmark-adapter.ts`
- 写回与回滚：`src/engine/optimizer/apply-service.ts`
- 会话存储：`src/engine/optimizer/session-store.ts`
- 设计与执行计划：`dev-docs/planning/2026-11-20-workflow-optimize-execution-plan.md`
- 真实 REC-002 审查记录：`.pi/workflows/optimizations/opt-20261123-001/review.md`
