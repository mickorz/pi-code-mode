// /workflows 参数补全契约：子命令名/注册表 id/runId 三级补全（纯逻辑，无模型）
//
// 关键契约：宿主 CombinedAutocompleteProvider 用 item.value 整段替换参数文本
// （beforePrefix + value + afterCursor），label 只做展示。所以 value 必须是完整参数串。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { completeWorkflowsArgs } from "../../apps/plugin/extensions/commands/workflows/completions.js";
import { registerJsonPath } from "../../packages/engine/src/runtime/workflow-registry.js";
import { RunManager } from "../../packages/manager/src/run-manager.js";

function makeProject(opts?: { manifest?: { id: string }[]; brokenLegacy?: boolean }) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-cmpl-test-"));
  if (opts?.manifest) {
    const file = registerJsonPath(projectDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, workflows: opts.manifest.map((m) => ({ ...m, file: "x.js", registeredAt: new Date().toISOString() })) }),
    );
  }
  if (opts?.brokenLegacy) {
    const dir = path.join(projectDir, ".opencode-workflows", "workflows");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bad.js"), "export const meta = { name: 'Bad Name' }\nconst x = 1");
  }
  return projectDir;
}

test("子命令补全: 空前缀给全部, 前缀过滤, 未知不猜", () => {
  const deps = { runManager: new RunManager(2), cwd: makeProject() };
  const all = completeWorkflowsArgs("", deps);
  assert.ok(all.length >= 11);
  assert.ok(all.every((i) => i.description));
  // value 带尾随空格：宿主整段替换后光标停在空格后，可继续补第二个参数
  assert.ok(all.every((i) => i.value.endsWith(" ")), "子命令补全 value 需带尾随空格");
  assert.deepEqual(completeWorkflowsArgs("re", deps).map((i) => i.value), ["register ", "reg "]); // KNOWN 表序
  assert.deepEqual(completeWorkflowsArgs("xyz", deps), []);
});

test("子命令补全: 敲完整子命令但无空格时不返回 workflowId（防宿主替换掉参数）", () => {
  const deps = { runManager: new RunManager(2), cwd: makeProject({ manifest: [{ id: "smoke_test" }] }) };
  for (const typed of ["unreg", "unregister", "run", "reg", "cancel"]) {
    const items = completeWorkflowsArgs(typed, deps);
    assert.ok(items.some((i) => i.value === `${typed} `), `${typed} 应补全自身，实际 ${JSON.stringify(items.map((i) => i.value))}`);
    assert.ok(!items.some((i) => i.label === "smoke_test"), `${typed} 不应返回 workflowId 候选`);
  }
  // 空格后才进入位置 2；内置不可注销，不进 unreg 候选
  assert.deepEqual(completeWorkflowsArgs("unreg ", deps).map((i) => i.value), ["unreg smoke_test"]);
});

test("位置 2 补全: value 必须是完整参数串（含已输入的动词），否则宿主会顶掉动词", () => {
  const deps = { runManager: new RunManager(2), cwd: makeProject({ manifest: [{ id: "smoke_test" }, { id: "daily_review" }] }) };
  // 回归（2026-11-20 线上 bug）：value 曾为裸 workflowId，输入 /workflows unreg smoke_test
  // 按 Tab/回车后变成 /workflows smoke_test（unreg 被整段替换掉）
  assert.deepEqual(completeWorkflowsArgs("run s", deps).map((i) => i.value), ["run smoke_test"]);
  const runAll = completeWorkflowsArgs("run ", deps).map((i) => i.value);
  assert.deepEqual(runAll.slice(0, 2), ["run smoke_test", "run daily_review"], "项目条目在前");
  for (const builtin of ["coder", "reviewer", "judge", "fixer", "quality-loop"]) {
    assert.ok(runAll.includes(`run ${builtin}`), `内置 ${builtin} 应可补全执行`);
  }
  assert.ok(!completeWorkflowsArgs("unreg ", deps).some((i) => i.value === "unreg coder"), "内置不进注销候选");
  assert.deepEqual(completeWorkflowsArgs("reg d", deps).map((i) => i.value), ["reg daily_review"]);
  assert.deepEqual(completeWorkflowsArgs("unreg smoke", deps).map((i) => i.value), ["unreg smoke_test"]);
  assert.deepEqual(completeWorkflowsArgs("unregister smoke", deps).map((i) => i.value), ["unregister smoke_test"]);
  // label 仍为可读 token
  assert.equal(completeWorkflowsArgs("unreg smoke", deps)[0].label, "smoke_test");
});

test("watch/status/cancel 后补全 runId（带状态描述）", () => {
  const rm = new RunManager(2);
  const deps = { runManager: rm, cwd: makeProject() };
  rm.register("run-1", { label: "冒烟" });
  rm.register("run-2");
  rm.finish("run-2", { status: "completed" });
  const all = completeWorkflowsArgs("watch ", deps);
  assert.deepEqual(all.map((i) => i.value), ["watch run-1", "watch run-2"]);
  assert.match(all[0].description!, /running/);
  assert.match(all[1].description!, /completed/);
  assert.deepEqual(completeWorkflowsArgs("watch run-1", deps).map((i) => i.value), ["watch run-1"]);
  assert.deepEqual(completeWorkflowsArgs("status ru", deps).map((i) => i.value), ["status run-1", "status run-2"]);
});

test("注册表读取失败（坏脚本）时补全降级为空, 不抛错", () => {
  const deps = { runManager: new RunManager(2), cwd: makeProject({ brokenLegacy: true }) };
  assert.deepEqual(completeWorkflowsArgs("run ", deps), []);
});

// ---- 用宿主真实补全器验证「整段替换」契约（回归 2026-11-20 线上 bug）----
test("宿主 CombinedAutocompleteProvider: 接受补全后动词不被顶掉", async () => {
  const { CombinedAutocompleteProvider } = await import("@earendil-works/pi-tui");
  const deps = { runManager: new RunManager(2), cwd: makeProject({ manifest: [{ id: "smoke_test" }] }) };
  const provider = new CombinedAutocompleteProvider(
    [{ name: "workflows", getArgumentCompletions: (prefix: string) => completeWorkflowsArgs(prefix, deps) }] as any,
    deps.cwd,
  );

  for (const line of ["/workflows unreg smoke_", "/workflows run smoke_", "/workflows unreg ", "/workflows unr"]) {
    const suggestions: any = await provider.getSuggestions([line], 0, line.length, {});
    assert.ok(suggestions?.items?.length, `${line} 应有候选`);
    for (const item of suggestions.items) {
      const applied: any = provider.applyCompletion([line], 0, line.length, item, suggestions.prefix);
      // 动词必须保留：/workflows <动词> ... 不能被替换成 /workflows <id>
      assert.ok(
        applied.lines[0].startsWith("/workflows unreg") ||
          applied.lines[0].startsWith("/workflows run") ||
          applied.lines[0].startsWith("/workflows un"),
        `${line} 选中 ${item.value} 后变成 ${applied.lines[0]}`,
      );
    }
  }
});
