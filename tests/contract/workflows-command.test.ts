// /workflows run 子命令参数解析契约（命令层与 workflow 工具共用）
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflowsRunArgs, renderRunStatus, splitCommandArgs } from "../../src/tools/workflow-tools.js";
import { RunManager } from "../../src/manager/run-manager.js";

test("run 参数: 仅脚本路径", () => {
  const r = parseWorkflowsRunArgs(["scripts/smoke.js"]);
  assert.equal(r.scriptPath, "scripts/smoke.js");
  assert.equal(r.args, undefined);
  assert.equal(r.error, undefined);
});

test("run 参数: key=value 按 JSON 转类型, 非 JSON 保持字符串", () => {
  const r = parseWorkflowsRunArgs(["daily-review.js", "topic=性能", "depth=3", "dry=true", "tags=[\"a\",\"b\"]"]);
  assert.equal(r.scriptPath, "daily-review.js");
  assert.deepEqual(r.args, { topic: "性能", depth: 3, dry: true, tags: ["a", "b"] });
});

test("run 参数: 值中含等号时按首个等号切分", () => {
  const r = parseWorkflowsRunArgs(["x.js", "q=a=b"]);
  assert.deepEqual(r.args, { q: "a=b" });
});

test("run 参数: 整段无等号 -> 自然语言指令落到 args.task（两字任务也合法）", () => {
  const r = parseWorkflowsRunArgs(["coder", "修复", "登录", "超时"]);
  assert.equal(r.scriptPath, "coder");
  assert.deepEqual(r.args, { task: "修复 登录 超时" });
  assert.equal(r.error, undefined);

  const shortTask = parseWorkflowsRunArgs(["coder", "修复"]);
  assert.deepEqual(shortTask.args, { task: "修复" });
});

test("run 参数: 缺路径 / key=value 混用裸词 / 过短裸词 返回 error", () => {
  assert.match(parseWorkflowsRunArgs([]).error!, /缺少/);
  assert.match(parseWorkflowsRunArgs(["a.js", "task=x", "flag"]).error!, /key=value/);
  assert.match(parseWorkflowsRunArgs(["a.js", "x"]).error!, /既不是 key=value 也不是指令文本/);
});

test("斜杠参数切分: 双引号/单引号包裹含空格的值, 引号丢弃", () => {
  assert.deepEqual(splitCommandArgs('coder task="修复 登录 超时" tier=fast'), [
    "coder",
    "task=修复 登录 超时",
    "tier=fast",
  ]);
  assert.deepEqual(splitCommandArgs("quality-loop task='两个 词' maxRepairRounds=2"), [
    "quality-loop",
    "task=两个 词",
    "maxRepairRounds=2",
  ]);
  assert.deepEqual(splitCommandArgs("   "), []);
  assert.deepEqual(splitCommandArgs('a "b c"'), ["a", "b c"]);
});

test("斜杠参数切分后仍可解析为 args: 带空格的成句 task", () => {
  const argv = splitCommandArgs('/coder task="修复 登录接口 超时重试" tier=fast');
  const r = parseWorkflowsRunArgs(argv);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.args, { task: "修复 登录接口 超时重试", tier: "fast" });
});

test("cancel/stop 选集: 只停在途运行, cancel 未知 id 返回 false", async () => {
  const rm = new RunManager(4);
  rm.register("a");
  rm.register("b");
  rm.register("c");
  rm.finish("b", { status: "completed" });
  const running = rm.list().filter((r) => r.status === "running").map((r) => r.runId);
  assert.deepEqual(running, ["a", "c"]); // stop 全部在途的选集语义
  assert.equal(await rm.cancel("a"), true);
  assert.equal(await rm.cancel("zzz"), false);
});

test("status 渲染: 未知 runId 自防御, 已知 runId 含状态行", () => {
  assert.match(renderRunStatus(null), /未找到/);
  const rm = new RunManager(2);
  rm.register("s1", { label: "lbl" });
  const text = renderRunStatus(rm.status("s1"));
  assert.match(text, /runId: s1/);
  assert.match(text, /running/);
});

// ---- /workflows 路由层（fake pi + 真 RunManager，无模型） ----

import { registerWorkflowsCommand } from "../../extensions/commands/workflows/index.js";
import { registerSubcommand, unregisterSubcommand } from "../../extensions/commands/workflows/register.js";
import { workflowsDir, loadRegistry } from "../../src/engine/runtime/workflow-registry.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeCapture() {
  const notifications: Array<{ text: string; level: string }> = [];
  const ctx = { cwd: "/tmp", ui: { notify: (text: string, level: string) => notifications.push({ text, level }) } };
  const pi: any = { registerCommand: (_name: string, opts: any) => (pi.handler = opts.handler) };
  return { notifications, ctx, pi };
}

function makeDepsStub() {
  return {
    runManager: new RunManager(2),
    makeDeps: () => {
      throw new Error("run 测试不应触达工具依赖");
    },
    deliver: async () => {},
  };
}

test("路由: 无参数显示帮助, cancel/stop 同义去重为一行", async () => {
  const { notifications, ctx, pi } = makeCapture();
  registerWorkflowsCommand(pi, makeDepsStub());
  await pi.handler("", ctx);
  assert.equal(notifications[0].level, "info");
  const helpLines = notifications[0].text.split("\n");
  assert.equal(helpLines[0], "workflow 子命令:");
  assert.equal(helpLines.filter((l) => l.includes("cancel")).length, 1); // stop 不重复出现
});

test("路由: 未知子命令 -> warning + 帮助", async () => {
  const { notifications, ctx, pi } = makeCapture();
  registerWorkflowsCommand(pi, makeDepsStub());
  await pi.handler("foo", ctx);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].text, /未知子命令: foo/);
});

test("路由: dispatch 到子命令（status 缺参 / cancel 无在途）", async () => {
  const { notifications, ctx, pi } = makeCapture();
  registerWorkflowsCommand(pi, makeDepsStub());
  await pi.handler("status", ctx);
  assert.match(notifications[0].text, /用法: \/workflows status/);
  await pi.handler("cancel", ctx);
  assert.match(notifications[1].text, /当前没有在途运行/);
  await pi.handler("stop", ctx); // stop 同样路由到 cancel 实现
  assert.match(notifications[2].text, /当前没有在途运行/);
});

// ---- register / unregister 子命令（真实临时目录文件系统，无模型） ----

import { registerJsonPath } from "../../src/engine/runtime/workflow-registry.js";

const DEMO_SCRIPT = `export const meta = { id: "demo_wf", name: "demo_wf", description: "demo" }\nreturn { ok: true }`;

function makeProject() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-reg-test-"));
  const { notifications, ctx, pi } = makeCapture();
  (ctx as any).cwd = projectDir;
  return { projectDir, notifications, ctx, pi };
}

test("register: 校验+manifest 记录原位路径(不复制), unregister 按 id 移除", async () => {
  const { projectDir, notifications, ctx } = makeProject();
  const deps = makeDepsStub();
  const src = path.join(projectDir, "sub", "demo.js"); // 子目录源文件，验证相对路径记录
  fs.mkdirSync(path.dirname(src));
  fs.writeFileSync(src, DEMO_SCRIPT);

  await registerSubcommand.run(["sub/demo.js"], ctx, deps);
  assert.match(notifications.at(-1)!.text, /已注册 workflow "demo_wf"/);
  assert.match(notifications.at(-1)!.text, /脚本保持原位/);
  const manifest = JSON.parse(fs.readFileSync(registerJsonPath(projectDir), "utf-8"));
  assert.equal(manifest.workflows[0].id, "demo_wf");
  assert.equal(manifest.workflows[0].file, "sub/demo.js"); // 原位相对路径, 非受管副本
  assert.ok(fs.existsSync(src)); // 源文件未动
  assert.ok(!fs.existsSync(path.join(projectDir, ".pi", "workflows", "workflows"))); // 不再产生副本目录
  const reg = loadRegistry(projectDir);
  assert.equal(reg.get("demo_wf")!.filePath, path.resolve(projectDir, "sub", "demo.js"));

  await unregisterSubcommand.run(["demo_wf"], ctx, deps); // 按 id 移除
  assert.match(notifications.at(-1)!.text, /已注销/);
  assert.match(notifications.at(-1)!.text, /重启会话后从补全列表消失/); // 运行中不可注销，需提示宿主限制
  assert.match(notifications.at(-1)!.text, /保留不动/);
  assert.equal(loadRegistry(projectDir).has("demo_wf"), false);
  assert.ok(fs.existsSync(src)); // 源文件保留

  await unregisterSubcommand.run(["demo_wf"], ctx, deps); // 再删一次 -> 未找到
  assert.match(notifications.at(-1)!.text, /未找到/);
});

test("register: id 冲突与坏脚本均拒绝注册", async () => {
  const { projectDir, notifications, ctx } = makeProject();
  const deps = makeDepsStub();
  const src = path.join(projectDir, "demo.js");
  fs.writeFileSync(src, DEMO_SCRIPT);
  await registerSubcommand.run(["demo.js"], ctx, deps);
  const manifestBefore = fs.readFileSync(registerJsonPath(projectDir), "utf-8");

  const other = path.join(projectDir, "other.js");
  fs.writeFileSync(other, DEMO_SCRIPT); // 同 id 不同文件 -> 冲突
  await registerSubcommand.run(["other.js"], ctx, deps);
  assert.match(notifications.at(-1)!.text, /已被占用/);
  assert.equal(fs.readFileSync(registerJsonPath(projectDir), "utf-8"), manifestBefore);

  const broken = path.join(projectDir, "broken.js");
  fs.writeFileSync(broken, "export const meta = { name: 'Bad Name' }\nconst x = 1"); // meta.name 非 snake_case -> 校验失败
  await registerSubcommand.run(["broken.js"], ctx, deps);
  assert.match(notifications.at(-1)!.text, /校验失败/);
  assert.equal(fs.readFileSync(registerJsonPath(projectDir), "utf-8"), manifestBefore);
});

test("双模式: manifest 存在即排他, 无 manifest 回退目录扫描", async () => {
  const { projectDir, notifications, ctx } = makeProject();
  const deps = makeDepsStub();
  const src = path.join(projectDir, "demo.js");
  fs.writeFileSync(src, DEMO_SCRIPT);
  await registerSubcommand.run(["demo.js"], ctx, deps);

  // 排他：legacy 目录里的手工文件不进注册表
  const legacyDir = path.join(projectDir, ".opencode-workflows", "workflows");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "stray.js"), DEMO_SCRIPT.replace("demo_wf", "stray_wf"));
  const registry = loadRegistry(projectDir);
  assert.ok(registry.has("demo_wf"));
  assert.equal(registry.get("demo_wf")!.builtin, undefined);
  assert.ok(!registry.has("stray_wf"));

  // fallback：无 manifest 的项目仍按旧目录扫描（坏脚本按文件名移除的出口保留）
  const legacyProject = fs.mkdtempSync(path.join(os.tmpdir(), "wf-legacy-test-"));
  const { notifications: n2, ctx: ctx2 } = makeCapture();
  (ctx2 as any).cwd = legacyProject;
  const legacyBroken = path.join(legacyProject, ".opencode-workflows", "workflows", "broken.js");
  fs.mkdirSync(path.dirname(legacyBroken), { recursive: true });
  fs.writeFileSync(legacyBroken, "const x = 1");
  await unregisterSubcommand.run(["broken.js"], ctx2, deps);
  assert.match(n2.at(-1)!.text, /已注销/);
});

// ---- 命令装配契约：注册进宿主的闭包必须在真实调用路径上可执行 ----
// 教训（2026-11-18 线上崩溃）：getArgumentCompletions 引用了作用域外的裸 runManager，
// 按 Tab 补全即抛 ReferenceError 打死宿主 TUI。单测只测纯函数 completeWorkflowsArgs 时漏掉了这层。
test("命令装配: /workflows 的 getArgumentCompletions 可真实调用（不抛 ReferenceError）", async () => {
  const { registerWorkflowsCommand } = await import("../../extensions/commands/workflows/index.js");
  const rm = new RunManager(4);
  rm.register("run-abc", { label: "smoke" });
  const registered = new Map<string, any>();
  const pi = { registerCommand: (name: string, opts: any) => registered.set(name, opts) } as any;

  registerWorkflowsCommand(pi, {
    runManager: rm,
    makeDeps: () => ({}) as any,
    deliver: async () => {},
  });

  const cmd = registered.get("workflows");
  assert.ok(cmd?.getArgumentCompletions, "getArgumentCompletions 已注册");

  // 空前缀：应能拿到子命令候选（证明闭包内的依赖可达）
  const all = cmd.getArgumentCompletions("");
  assert.ok(Array.isArray(all) && all.length > 0, "空前缀返回候选列表");
  assert.ok(all.some((c: any) => String(c.value ?? c.label ?? "").includes("status")));

  // 带 runId 前缀：走到 runManager 分支，不得抛错
  const runs = cmd.getArgumentCompletions("status ");
  assert.ok(Array.isArray(runs), "runId 补全分支可执行");
});

test("命令装配: /explorer 的 getArgumentCompletions 可真实调用", async () => {
  const { registerExplorerCommand } = await import("../../extensions/commands/explorer.js");
  const { RuntimeEventBus } = await import("../../src/engine/events/runtime-event-bus.js");
  const { ExplorerController } = await import("../../src/explorer/controller/explorer-controller.js");
  const bus = new RuntimeEventBus();
  const explorer = new ExplorerController({ runManager: new RunManager(2, bus), eventBus: bus, journalDir: "/tmp/none" });
  const registered = new Map<string, any>();
  const pi = { registerCommand: (name: string, opts: any) => registered.set(name, opts) } as any;
  registerExplorerCommand(pi, { explorer });
  const cmd = registered.get("explorer");
  assert.doesNotThrow(() => cmd.getArgumentCompletions("run-"));
  explorer.dispose();
});
