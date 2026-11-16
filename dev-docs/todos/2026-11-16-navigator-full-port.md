# Navigator 全屏交互面板完整复刻（P0）

> 状态：待启动　|　决策记录：2026-11-16（对比文档 §2.1，弃最小版改完整复刻）
> 参考：`thirdparties/pi-dynamic-workflows/src/workflow-ui.ts`（~2400 行，只读）

## 目标

在本仓库复刻参考项目的 workflows Navigator 全屏交互面板：`/workflows`（或子命令 `ui`）打开 overlay，
集中完成 runs 浏览、详情钻取、过滤、确认类操作（stop/删除等），替代当前纯文本 list/status 的浏览体验。

## 复刻范围（逐组件）

1. **overlay 容器**：宿主 overlay 组件接入（94%/92%、center + right-center 侧边栏锚点、盒式边框、主题着色、视口自适应）
2. **状态机**：browse / filter / rename / confirm 四态
3. **视图层**：runs 列表 → run 详情钻取（绑定不可变 frame runId）→ saved 工作流详情
4. **确认体系**：ConfirmKind + pending 三重上下文绑定（cursor/filter/runId）、confirm/cancel/execute/notifyMutation
5. **渲染**：renderNavigatorFrame + renderCache、markdown 主题、pager 翻页、宽度感知截断（truncateToWidth/visibleWidth）
6. **交互**：act(data) 键盘分发

## 本仓库适配点（与参考项目的机制差异）

- 数据源：RunManager.list/status（在途+终态快照）；已结束 run 详情需新增 **journal 快照读取**（参考项目走 run-persistence，本仓库无此层）
- 工作流视图：saved 详情映射到 `.pi/workflows/register.json` manifest 条目（原位路径引用）
- 操作映射：stop → `runManager.cancel`（journal 保留可续跑）；删除类操作按本仓库语义裁剪（journal 一律保留，rm 仅在评估后决定）
- 宿主 API 差异先出映射清单：overlay options / setWidget / 主题色名 / tui.terminal

## 验收口径

- `/workflows` 或 `/workflows ui` 打开面板；键盘浏览/过滤/钻取/确认全流程可用
- 在途 run 的 stop 确认生效（journal 保留，可 resumeFromRunId 续跑）
- 渲染在窄终端不破版（截断/翻页正常）
- `npm run build` + contract/engine 全绿；守卫测试不破坏命令结构规范

## 依赖与顺序建议

- 前置无硬依赖；建议与「widget 事件驱动化（P0）」并行推进（RunManager 事件回调可同时服务 navigator 实时刷新）
- 实施时按 CLAUDE.md「extensions 命令开发规范」落位：UI 组件代码建议 `extensions/commands/workflows/navigator/`（或独立 `extensions/ui/`，实施时定）
