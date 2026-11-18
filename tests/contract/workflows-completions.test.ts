// /workflows 参数补全契约：子命令名/注册表 id/runId 三级补全（纯逻辑，无模型）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { completeWorkflowsArgs } from "../../extensions/commands/workflows/completions.js";
import { registerJsonPath } from "../../src/engine/runtime/workflow-registry.js";
import { RunManager } from "../../src/manager/run-manager.js";

const DEMO = `export const meta = { id: "smoke_test", name: "smoke_test", description: "冒烟" }\nreturn {}`;

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
  const rm = new RunManager(2);
  const deps = { runManager: rm, cwd: makeProject() };
  const all = completeWorkflowsArgs("", deps);
  assert.ok(all.length >= 11);
  assert.ok(all.every((i) => i.description));
  const re = completeWorkflowsArgs("re", deps);
  assert.deepEqual(re.map((i) => i.value), ["register", "reg"]); // KNOWN 表序
  assert.deepEqual(completeWorkflowsArgs("xyz", deps), []);
});

test("run/register 后补全注册表 workflowId, unreg 同理", () => {
  const rm = new RunManager(2);
  const deps = { runManager: rm, cwd: makeProject({ manifest: [{ id: "smoke_test" }, { id: "daily_review" }] }) };
  const s = completeWorkflowsArgs("run s", deps);
  assert.deepEqual(s.map((i) => i.value), ["smoke_test"]);
  assert.deepEqual(completeWorkflowsArgs("run ", deps).map((i) => i.value), ["smoke_test", "daily_review"]);
  assert.deepEqual(completeWorkflowsArgs("reg d", deps).map((i) => i.value), ["daily_review"]);
  assert.deepEqual(completeWorkflowsArgs("unreg smoke", deps).map((i) => i.value), ["smoke_test"]);
});

test("watch/status/cancel 后补全 runId（带状态描述）", () => {
  const rm = new RunManager(2);
  const deps = { runManager: rm, cwd: makeProject() };
  rm.register("run-1", { label: "冒烟" });
  rm.register("run-2");
  rm.finish("run-2", { status: "completed" });
  const all = completeWorkflowsArgs("watch ", deps);
  assert.deepEqual(all.map((i) => i.value), ["run-1", "run-2"]);
  assert.match(all[0].description!, /running/);
  assert.match(all[1].description!, /completed/);
  assert.deepEqual(completeWorkflowsArgs("watch run-1", deps).map((i) => i.value), ["run-1"]);
});

test("注册表读取失败（坏脚本）时补全降级为空, 不抛错", () => {
  const rm = new RunManager(2);
  const deps = { runManager: rm, cwd: makeProject({ brokenLegacy: true }) };
  assert.deepEqual(completeWorkflowsArgs("run ", deps), []);
});
