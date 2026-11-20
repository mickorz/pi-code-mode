# Workflow 顶层斜杠命令直跑 执行报告

> 对应计划：`dev-docs/planning/completed/2026-11-20-workflow-direct-slash-commands-执行计划.md`
> 对应调研：`dev-docs/research/2026-11-20-pi-dynamic-workflows-slash-command-integration.md`
> 执行日期：2026-11-20
> 状态：T1-T5 完成，T6 自动化验证通过；交互式 TUI 端到端待人工

---

## 一、交付内容

| 文件 | 类型 | 说明 |
|---|---|---|
| `extensions/commands/workflows/direct-commands.ts` | 新增（约 190 行） | 顶层命令注册器：命名规则、冲突检测、调用时求值 handler、执行链转发 |
| `extensions/commands/workflows/index.ts` | 修改 | re-export 直跑注册器（同时满足架构守卫） |
| `extensions/pi-code-mode.ts` | 修改 | session_start 装配 + 跳过项汇总 warning |
| `extensions/commands/workflows/register.ts` | 修改 | 注册成功提示按命名安全性分支说明直跑可用性 |
| `tests/contract/workflow-direct-commands.test.ts` | 新增（12 用例） | 命名/冲突/注册/legacy 排除/注销兜底/参数短路/装配 |

## 二、实现要点

### 执行链零新增

handler 只做三件事：查注册表 → 解析 `key=value` → 转发 `makeWorkflowTool(..., background: true)`。脚本读取、meta 校验、journal、RunManager、结果回传全部沿用既有链路，与 `/workflows run` 完全同链。

### 三个关键防护

1. **调用时求值**：pi 无命令注销 API，`unregister` 后旧 `/<id>` 残留到会话重启。handler 每次触发重查 manifest + registry，已注销只 warning 不执行。
2. **manifest-only**：仅 `.pi/workflows/register.json` 显式注册项获得顶层命令；legacy 目录扫描项目零注册，避免存量脚本污染补全。
3. **冲突单向降级**：命名不安全/保留名/他扩展占用 → 跳过顶层别名并汇总 warning，`/workflows run <id>` 始终可用，功能零损失。

### 与计划的两处实现细化

| 计划 | 实现 | 原因 |
|---|---|---|
| 注册器内 `seen` 集合防重复注册 | 删除 | `loadRegistry` 返回 Map，key 天然唯一；重复 id 由既有 `loadRegistry` 抛错路径覆盖 |
| 冲突检测仅在 getCommands 正常时进行 | getCommands 抛错 → 返回「无法读取命令列表，跳过」并拒绝注册 | 无法证实无冲突时不该放行，符合项目「不静默改变行为」约定 |

## 三、验证证据

### 构建

```
npm run build   # tsc (src + extensions) 通过，无类型错误
```

### 契约测试

```
npx tsx --test tests/contract/workflow-direct-commands.test.ts
✔ 12 tests, 12 pass, 0 fail

npm run test:contract
ℹ tests 229  ℹ pass 229  ℹ fail 0
```

覆盖项：

| 用例 | 断言要点 |
|---|---|
| 命名规则 | `smoke_test`/`a1-b` 合法；空、空白、路径分隔符、点号、中文、连字符开头、超 64 字符非法 |
| 冲突检测 | `new`/`debug` 保留、`workflows`/`schedule` 本扩展、他扩展占用、无冲突 |
| getCommands 不可用 | 拒绝注册而非放行 |
| manifest 注册 | 注册成功且 description 含「等价 /workflows run」 |
| legacy 模式 | 零次 registerCommand |
| 命名/冲突跳过 | skipped 含原因，不注册 |
| 注册表损坏 | 返回含原始错误的诊断，不抛出不注册 |
| 注销兜底 | 提示「已注销」，`makeDeps` 零调用 |
| 参数非法 | 提示 key=value 错误，`makeDeps` 零调用 |
| 注册表不可读 | 提示原始错误，`makeDeps` 零调用 |
| 装配互不干扰 | `/workflows` 与 `/<id>` 共存，注册器不覆盖 `/workflows` |

### 真实注册表装配自检

对本仓库 `.pi/workflows/register.json`（两条真实条目）执行注册器：

```
registered: [ 'schema_result_view', 'smoke_test' ]
skipped: []
/schema_result_view -> workflow: 结构化结果详情展示验收（脱敏/截断/空态）（等价 /workflows run schema_result_view）
/smoke_test -> workflow: 最小冒烟：2 个 agent 并行（等价 /workflows run smoke_test）
```

（自检脚本为一次性验证，已删除，不在仓库留档；等价逻辑由 contract 测试覆盖。）

## 四、待人工验证项（T6 剩余）

以下需交互式 pi 会话，自动化不便覆盖：

1. `pi -ne -e <repo>` 干净房间启动
2. 输入 `/smoke` 确认补全列表出现 `/smoke_test`
3. `/smoke_test foo=bar` 执行 → widget 进度 → 结果回传会话
4. `/workflows unregister smoke_test` 后再 `/smoke_test` → 确认仅提示已注销
5. 重启会话 → 确认 `/smoke_test` 从补全消失
6. 注册一个保留名（如 `new`）→ 重启 → 确认汇总 warning 出现且 `/workflows run new` 可用

## 五、遗留与已知限制

| 项 | 说明 |
|---|---|
| 保留名清单需随宿主升级维护 | `PI_RESERVED_COMMAND_NAMES` 抄录自 pi 1.4.x（24 公开 + 3 直达）；宿主未从包主入口导出该清单 |
| 当前会话注册的 workflow 无顶层命令 | 需重启会话（宿主无命令热注册/注销的可靠 API） |
| legacy 项目无顶层命令 | 设计决策，非缺陷 |
| 无设置开关 | 显式 manifest 已控制规模，YAGNI |

## 六、commit 记录

| commit | 内容 |
|---|---|
| `514b39b` | 调研报告（含 submodule 初始化） |
| `937199c` | 执行计划初稿 |
| `b72da50` | 评审修订 R1-R7 |
| 见 git log | 实现：direct-commands + 装配 + 测试 |

## 七、参考

- 计划：`dev-docs/planning/completed/2026-11-20-workflow-direct-slash-commands-执行计划.md`
- 调研：`dev-docs/research/2026-11-20-pi-dynamic-workflows-slash-command-integration.md`
- 第三方参考：`thirdparties/pi-dynamic-workflows/src/{saved-commands,command-registry}.ts`
