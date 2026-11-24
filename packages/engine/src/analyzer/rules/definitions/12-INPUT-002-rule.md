# INPUT-002：阶段输入校验范围超出目标阶段

| 元信息 | 值 |
| --- | --- |
| 规则 ID | INPUT-002 |
| 严重度 | medium |
| 置信度 | 0.85 |
| 检查方式 | AST 静态分析（`effectiveStartIdx` 条件与 `check(fileExists(...))` 的交叉） |
| 规则集版本 | 1.0 |

## 检查什么

阶段起点分支要求了该阶段并不需要的输入 → 阶段级恢复被无关输入阻断

## 为什么是问题

支持 `from-stage` / `retryScope` 的 workflow 会按起点跳过已完成阶段：

```js
if (effectiveStartIdx <= 3) {
  await check(() => fileExists(codeDir), '客户端代码工程不存在')      // 只有 S4 需要
  await check(() => fileExists(fguiDir), 'FairyGUI 工程不存在')       // 只有 S4 需要
}
if (effectiveStartIdx <= 4) {
  await check(() => fileExists(serverSrcRoot), '服务端源码根不存在')  // 只有 S5 需要
}
```

从 S5 开始时 `effectiveStartIdx === 4`，第一个块（`<= 3`）不执行——这部分是对的。
但只要条件写成 `<= 4` 或所有校验都放在同一个块里，就会出现：

- **只重跑服务端时仍要求客户端目录存在**
- 恢复的独立性被破坏：用户得先准备好完全无关的客户端代码树

这个问题不报错、不警告，表现为"路径检查失败"，很容易被误认为环境问题而浪费排查时间。

## 命中判定（实现口径）

1. 源码存在阶段起点判断，形态为 `effectiveStartIdx <= N`（或等价的 `startIdx <= N` / `startStage` 比较）；
2. 该条件块内调用 `check(() => fileExists(<pathVar>), ...)` 或 `existsSync(<pathVar>)`；
3. 声明的起点分支**不需要**该输入——判定依据：
   - 该 `pathVar` 在源码中的其他使用点只出现在**比 N 更大的**阶段索引块里
   - 或 `pathVar` 的语义名（`codeDir`/`fguiDir` vs `serverSrcRoot`）与另一侧阶段明确对立

命中时给出两处证据：校验位置 + 该输入真正被使用的阶段位置。

**不命中**：

```js
// ✗ 条件正确：S4 输入只在 <= 3 分支校验
if (effectiveStartIdx <= 3) await check(() => fileExists(codeDir), '...')
if (effectiveStartIdx <= 4) await check(() => fileExists(serverSrcRoot), '...')
```

## 报出的证据

- `N 处输入校验在起点 <= X 的分支里要求了 Y 需要的输入（行 a；实际使用在行 b）`
- 受影响的恢复模式（`from-stage startStage=S5` / `retryScope=server`）

## 建议怎么改

按阶段各自的输入集合拆开校验块：

```js
if (effectiveStartIdx <= 3) {           // S4 需要
  await check(() => fileExists(codeDir), '客户端代码工程不存在')
  await check(() => fileExists(fguiDir), 'FairyGUI 工程不存在')
}
if (effectiveStartIdx <= 4) {           // S5 需要
  await check(() => fileExists(serverSrcRoot), '服务端源码根不存在')
}
```

若支持 `retryScope`，还要按 scope 进一步收窄：`retryScope === 'server'` 时只校验服务端输入。

## 已知误报与局限

- 只识别 `effectiveStartIdx <= N` 这类**字面量比较**；通过变量间接计算起点（`const idx = f(mode)`）的判定会退化
- 路径变量与阶段的对应关系依赖命名与使用点推断，语义命名不规范时可能误判
- 无法判断某个输入是否"间接必需"（例如客户端目录里也放着共享配置）

## 验收口径

1. 删除客户端目录后，`from-stage startStage=S5` 仍能正常启动并按预期执行服务端阶段
2. 删除服务端目录后，`from-stage startStage=S4` 能启动，并在 S5 阶段正确地失败
3. `retryScope=server` 时，客户端目录缺失不构成阻断

## 关联

- 实现：`src/engine/analyzer/rules/index.ts`（`inputScopeMismatch`）
- 同类规则：`01-INPUT-001-rule.md`（重复注入大对象）
- 人工审计依据：`dev-docs/troubleshooting/2026-11-19-game-requirement-audit-workflow-analysis.md` P1-003
- 真实案例：`game-requirement-audit.js` 的 `check(() => fileExists(codeDir))` 与 `effectiveStartIdx <= 3`
