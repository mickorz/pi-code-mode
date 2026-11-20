# INPUT-001 在真实仓库上大量误报（标识符 ≠ 注入数据）

- 日期：2026-11-19
- 触发场景：用 `thirdparties/PrdGameSkill`（36 个真实生产 workflow）做 Analyzer 验收
- 相关规则：`src/engine/analyzer/rules/index.ts` 的 `INPUT-001`

## 问题现象

真实仓库扫描结果：`game-requirement-audit.js` 报 **17 条 INPUT-001**、风险分 83；全仓 34/36 脚本有 finding、平均风险分 24。

但抽查 evidence 全是噪声：

```
标识符 `filePath` 在 2 个 agent/workflow 调用中出现（行 129, 142）
标识符 `join`     在 2 个 agent/workflow 调用中出现（行 129, 142）
标识符 `withModel` 在 5 个 agent/workflow 调用中出现
标识符 `label`    在 5 个 agent/workflow 调用中出现
标识符 `def` / `script` / `Object` …
```

对照源码（`game-requirement-audit.js:126-150`）：这些是**工具函数名、对象属性键名、参数名**，根本不是"重复注入的大对象"。

## 排查过程

1. 先看 `ast-parser.ts` 的 `collectIdentifiers`：它对调用表达式参数做全量递归，把 `join(...)` 的 callee、`{ label: x }` 的键名都收进了 `referencedIdentifiers`。
2. 再看 `INPUT-001` 判定：只要同一标识符出现在 ≥2 个 agent/workflow 调用里就报——**没有任何体积判定**。
3. 之前只在 7 个原子 fixture 上测过，fixture 里"重复注入"恰好是同一个大对象变量，所以规则看着是对的。这是典型的「小样本掩盖规则缺陷」。

## 根因

两个叠加缺陷：

- **收集层过宽**：标识符收集未排除被调用函数名与对象键名。
- **判定层无体积门槛**：`出现≥2 次` 不等于 `重复注入大对象`。

## 解决方案

1. `collectIdentifiers`：
   - `CallExpression` 只收集 `callee.object` 与被调参数（不收集函数名 / 方法名）
   - `Property` 只收集 value（不收集键名）
2. `INPUT-001` 增加三项准入（满足其一才报）：
   - `JSON.stringify(ident)` 整体注入
   - 声明处为大数组/大对象字面量（≥200 字符）
   - 变量名为整体性语义名（`requirements` / `rules` / `context` / `evidence` 等，**按整词匹配**）

   注意：语义词正则必须整词匹配。第一版写成 `/...|list/i` 时 `list` 命中了 `label`，仍需继续误报。

## 结果

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| game-requirement-audit findings | 15~17（几乎全 INPUT-001） | 1（RETRY-001，真实） |
| game-requirement-audit risk | 83 | **2** |
| 全仓平均风险分 | 24 | **6** |
| M1 benchmark recall / FPR | 100% / 0% | 100% / 0%（未回归） |

误报清零后仍保留真实 finding（如 `server-rule-verify` 的 SERIAL-001 串行链、多处 RETRY-001）。

## 教训（可复用）

1. **规则必须用真实仓库验，不能只用自造 fixture**。自造 fixture 天然符合规则作者的假设，无法暴露"过度匹配"。
2. **"出现次数"不是风险信号，只是候选**。任何基于计数的规则都要加体积/语义准入，否则必然在真实代码上噪声爆炸。
3. **语义词表用整词匹配**，不要用 `includes`/宽松正则（`list` ⊂ `label`）。
4. 扫描结果要能一眼看出规则分布：本次正是"17 条同一个 rule"这个形态暴露了问题。

## 相关

- 验收脚本：`dev-examples/prdgame-skill-acceptance/scan-analyzer.mts`
- 结果数据：`dev-examples/prdgame-skill-acceptance/results/analyzer-scan.json`
- 真实样本仓库：`thirdparties/PrdGameSkill`（REF-016）
