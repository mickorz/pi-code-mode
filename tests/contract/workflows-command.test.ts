// /workflows run 子命令参数解析契约（命令层与 workflow 工具共用）
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflowsRunArgs, renderRunStatus } from "../../src/tools/workflow-tools.js";
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

test("run 参数: 缺路径或非法 token 返回 error", () => {
  assert.match(parseWorkflowsRunArgs([]).error!, /缺少/);
  assert.match(parseWorkflowsRunArgs(["a.js", "flag"]).error!, /key=value/);
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

import { registerJsonPath, managedWorkflowsDir } from "../../src/engine/runtime/workflow-registry.js";

const DEMO_SCRIPT = `export const meta = { id: "demo_wf", name: "demo_wf", description: "demo" }\nreturn { ok: true }`;

function makeProject() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-reg-test-"));
  const { notifications, ctx, pi } = makeCapture();
  (ctx as any).cwd = projectDir;
  return { projectDir, notifications, ctx, pi };
}

test("register: 校验+副本落盘+manifest 记录, 注册表可见; unregister 按 id 移除", async () => {
  const { projectDir, notifications, ctx } = makeProject();
  const deps = makeDepsStub();
  const src = path.join(projectDir, "demo.js");
  fs.writeFileSync(src, DEMO_SCRIPT);

  await registerSubcommand.run(["demo.js"], ctx, deps);
  assert.match(notifications.at(-1)!.text, /已注册 workflow "demo_wf"/);
  const manifest = JSON.parse(fs.readFileSync(registerJsonPath(projectDir), "utf-8"));
  assert.equal(manifest.workflows[0].id, "demo_wf");
  assert.ok(fs.existsSync(path.join(projectDir, manifest.workflows[0].file))); // 副本在受管目录
  assert.ok(loadRegistry(projectDir).has("demo_wf"));

  await unregisterSubcommand.run(["demo_wf"], ctx, deps); // 按 id 移除
  assert.match(notifications.at(-1)!.text, /已注销/);
  assert.equal(loadRegistry(projectDir).size, 0);
  assert.equal(fs.readdirSync(managedWorkflowsDir(projectDir)).length, 0); // 副本同步删除

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
  fs.writeFileSync(broken, "const x = 1"); // 无 meta -> 校验失败
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
  assert.equal(registry.size, 1);
  assert.ok(registry.has("demo_wf"));
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
