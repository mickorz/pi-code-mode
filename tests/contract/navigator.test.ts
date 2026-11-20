// Navigator 完整复刻：状态机/按键映射/渲染宽度契约（纯逻辑，无模型无 TUI）
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mapKey } from "../../extensions/commands/workflows/navigator/keys.js";
import { NavigatorModel } from "../../extensions/commands/workflows/navigator/model.js";
import { renderNavigatorFrame, renderOverlayBox, type ThemeLike } from "../../extensions/commands/workflows/navigator/render.js";

const RUNS = [
  {
    runId: "run-1",
    label: "冒烟",
    status: "running",
    startedAt: Date.now(),
    agents: [
      { id: "run-1:0", label: "发现", status: "ok", phase: "Scan", durationMs: 1200, tokens: 100 },
      { id: "run-1:1", label: "回显", status: "running", phase: "Echo" },
    ],
  },
  { runId: "run-2", label: "已完成", status: "completed", startedAt: Date.now(), finishedAt: Date.now(), agents: [{ id: "run-2:0", label: "a", status: "ok" }] },
];
const SAVED = [{ id: "smoke_test", name: "smoke_test", description: "最小冒烟", file: "dev-examples/x.js" }];

function makeModel() {
  const m = new NavigatorModel();
  m.setData(RUNS as any, SAVED);
  return m;
}

const noopTheme: ThemeLike = { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s };

// ---- 按键映射 ----

test("mapKey: 方向键/回车/esc/退格归一化", () => {
  assert.equal(mapKey("\x1b[A"), "up");
  assert.equal(mapKey("\x1b[B"), "down");
  assert.equal(mapKey("\r"), "enter");
  assert.equal(mapKey("\x1b"), "escape");
  assert.equal(mapKey("\x7f"), "backspace");
  assert.equal(mapKey("x"), "x");
  assert.equal(mapKey("过"), "过");
  assert.equal(mapKey("\x1b[Z"), "shiftTab");
  assert.equal(mapKey("\x1b[1;5A"), "unknown");
});

// ---- 状态机：导航 ----

test("model: 光标移动与钳制、tab 切换视图", () => {
  const m = makeModel();
  m.act("down");
  m.act("j");
  const s1 = m.snapshot(10);
  assert.equal(s1.cursor.runs, 1); // 2 项列表光标钳制在末尾
  m.act("G");
  assert.equal(m.snapshot(10).cursor.runs, 1);
  m.act("g");
  assert.equal(m.snapshot(10).cursor.runs, 0);
  m.act("tab");
  assert.equal(m.snapshot(10).view, "saved");
  m.act("tab");
  assert.equal(m.snapshot(10).view, "runs");
});

test("model: enter 钻取详情, esc 返回, 根视图 esc/q 关闭", () => {
  const m = makeModel();
  m.act("enter");
  assert.equal(m.snapshot(10).view, "detail");
  assert.equal(m.snapshot(10).detail?.runId, "run-1");
  m.act("escape");
  assert.equal(m.snapshot(10).view, "runs");
  m.act("q");
  const effects = m.act("escape");
  assert.deepEqual(effects, [{ kind: "close" }]);
});

test("model: 过滤模式逐字输入生效, enter 退出过滤保留词", () => {
  const m = makeModel();
  m.act("/");
  assert.equal(m.snapshot(10).mode, "filter");
  for (const ch of "冒") m.act(ch);
  m.act("enter");
  const s = m.snapshot(10);
  assert.equal(s.mode, "browse");
  assert.equal(s.filter, "冒");
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0].runId, "run-1");
  // saved 视图同样受过滤
  m.act("tab");
  assert.equal(m.snapshot(10).saved.length, 1);
});

// ---- 状态机：确认流（三重绑定）----

test("model: x 触发停止确认, 再按 x 产出 exec-stop, esc 取消", () => {
  const m = makeModel();
  m.act("x");
  let s = m.snapshot(10);
  assert.equal(s.mode, "confirm");
  assert.match(s.confirmPrompt!, /再按 x/);
  m.act("escape"); // 取消
  assert.equal(m.snapshot(10).mode, "browse");
  m.act("x");
  const effects = m.act("x"); // 同键确认
  assert.deepEqual(effects, [{ kind: "exec-stop", runId: "run-1" }]);
  assert.equal(m.snapshot(10).mode, "browse");
});

test("model: u 触发注销确认（saved 视图）, 产出 exec-unregister", () => {
  const m = makeModel();
  m.act("tab");
  m.act("u");
  assert.equal(m.snapshot(10).mode, "confirm");
  const effects = m.act("u");
  assert.deepEqual(effects, [{ kind: "exec-unregister", id: "smoke_test" }]);
});

test("model: 空列表上 x/u 不产生确认", () => {
  const m = new NavigatorModel();
  m.setData([], []);
  assert.deepEqual(m.act("x"), []);
  m.act("tab");
  assert.deepEqual(m.act("u"), []);
});

// ---- 渲染 ----

test("render: 所有行可见宽度不超 inner 宽度, 含光标标记与边框", () => {
  const m = makeModel();
  m.act("down");
  const s = m.snapshot(8);
  const width = 60;
  const lines = renderOverlayBox(s, width, 8, noopTheme);
  assert.ok(lines.length >= 8);
  assert.equal(lines[0].startsWith("╭─"), true);
  assert.equal(lines.at(-1)!.startsWith("╰"), true);
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `行超宽: ${visibleWidth(line)} > ${width}`);
  const body = renderNavigatorFrame(s, width - 4, 8, noopTheme);
  assert.ok(body.some((l) => l.includes("❯"))); // 光标标记
  assert.ok(body.some((l) => l.includes("[RUN]")));
});

test("render: confirm 态出现确认横幅; 过滤态显示 filter 指示", () => {
  const m = makeModel();
  m.act("x");
  const frame = renderNavigatorFrame(m.snapshot(8), 60, 8, noopTheme);
  assert.ok(frame.some((l) => l.includes("[确认]") && l.includes("再按 x")));
  m.act("escape");
  m.act("/");
  for (const ch of "ab") m.act(ch);
  const frame2 = renderNavigatorFrame(m.snapshot(8), 60, 8, noopTheme);
  assert.ok(frame2.some((l) => l.includes("filter: ab▌")));
});

test("render: 详情视图展示节点行与回放标记", () => {
  const m = makeModel();
  const runs = [{ ...RUNS[0], agents: [{ ...RUNS[0].agents[0], replayed: true }] }] as any;
  m.setData(runs, SAVED);
  m.act("enter");
  const frame = renderNavigatorFrame(m.snapshot(8), 70, 8, noopTheme);
  assert.ok(frame.some((l) => l.includes("runId: run-1")));
  assert.ok(frame.some((l) => l.includes("1.2s") && l.includes("100tok") && l.includes("[回放]")));
});
