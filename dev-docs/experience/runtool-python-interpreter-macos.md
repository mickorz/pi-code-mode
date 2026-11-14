# runTool .py 解释器写死 python 在 macOS 全军覆没

## 问题现象

全量单测 11 个用例红，全部集中在 `tests/engine/runtool.test.ts`：

```
Error [WorkflowError]: 工具执行失败（exit 1）：tools/probe.py
```

`git stash` 验证 HEAD 同样 11 红——**存量问题**，非本次改动引入（M4 记录"234 全绿"时环境里应有可用的 `python`）。

## 排查过程

1. 测试 fixture 本身极简（写临时目录 `tools/probe.py`，`print(json.dumps(...))`），手跑 `python3 probe.py` 正常。
2. `which python` → 不存在；`which python3` → `/opt/homebrew/bin/python3`。本机 Homebrew 只装 python3，无 `python` 别名。
3. `src/engine/runtime/workflow-runtime.ts` 的 `TOOL_INTERPRETER = { ".py": "python", ".js": "node" }` 写死 `python` → execFile ENOENT → 测试全红。

## 根因

解释器名硬编码。macOS 自 Python 2 移除后系统只有 `python3`；Linux 发行版/venv 习惯 `python`。

## 解决方案

模块加载时一次性探测，优先 `python`（venv/Linux），回落 `python3`，两端都缺保留 `python` 让执行期报错暴露环境问题：

```ts
const PYTHON_BIN = ["python", "python3"].find(
  (bin) => spawnSync(bin, ["-V"], { stdio: "ignore" }).status === 0,
) ?? "python"
const TOOL_INTERPRETER: Record<string, string> = { ".py": PYTHON_BIN, ".js": "node" }
```

resume 无影响：runTool 执行记录走 executions 通道不写 hash（runtool.test.ts 自身断言了这一点），解释器选择不进缓存键。

结果：233 pass / 0 fail 全绿。

## 预防/注意事项

- 外部解释器/命令类依赖在启动时探测一次，不硬编码名字；`.sh` 白名单走 shebang（`execFile` 直接执行文件）不受影响。
- 单测"环境绿"会随机器漂移，CI 或换机后首件事跑全量单测对基线。
