# 斜杠命令参数补全：value 必须是整段参数串，否则会顶掉已输入的动词

## 问题现象

`/workflows unreg smoke_test` 回车（或按 Tab 选中候选）后，输入框内容变成 `/workflows smoke_test`，
`unreg` 凭空消失；随后命令按未知子命令处理或直接跑错分支。同理影响 `run unreg` 以外的
`watch/status/cancel`（`/workflows status run-1` 变 `/workflows run-1`）。

## 排查过程

1. 先怀疑补全的「位置分级」逻辑：以为敲完 `unreg`（无空格）被当成已选中子命令，提前返回了位置 2 的
   workflowId 候选。修掉后症状仍在 → 不是候选列表的问题。
2. 直接读宿主源码 `pi-coding-agent/dist/bundle/chunks/chunk-6MWTY2OB.js` 的 `CombinedAutocompleteProvider`：
   - `getSuggestions()` 对斜杠命令返回 `{ items, prefix: argumentText }`，其中 `argumentText`
     是**命令名之后的整段参数文本**（如 `"unreg smoke_test"`）。
   - `applyCompletion()` 里 `beforePrefix = line.slice(0, cursorCol - prefix.length)`，
     新行 = `beforePrefix + item.value + afterCursor`，即用 `item.value` **整段替换**参数文本。
   - `label` 只用于列表展示。
3. 对照宿主内置 `/mcp` 命令的补全实现：`value: `${action} ${serverName}`` —— 它返回的正是完整参数串。
   我们的实现返回裸 token（`value: "smoke_test"`），于是整段 `unreg smoke_test` 被替换成 `smoke_test`。

## 根因

`getArgumentCompletions` 的 `value` 语义是「补全后的完整参数文本」，不是「当前这一个 token」。

## 解决方案

- 位置 2（workflowId / runId）返回 `value: `${head} ${id}``，`label: id`；
- 位置 1（子命令名）返回 `value: `${k} ``（带尾随空格，便于 Tab 后接着补第二个参数，与宿主 `/mcp` 同款）；
- 位置 1 的判定只看「是否已敲空格 / 是否只有首个 token」，不要用「是否等于已知子命令」——
  否则会提前跳到位置 2。

## 预防

- 补全必须有「用宿主真实 `CombinedAutocompleteProvider` 跑一遍 `getSuggestions` + `applyCompletion`」
  的契约测试，断言补全后动词仍在（`tests/contract/workflows-completions.test.ts` 末条用例）。
  只测纯函数返回的 `value` 列表不足以发现这类宿主契约问题。
- 新增任何 `getArgumentCompletions` 实现时，先读一次宿主 `applyCompletion` 的替换算法。
