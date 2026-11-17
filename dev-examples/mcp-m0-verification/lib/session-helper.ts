/**
 * M0 公共助手：隔离会话创建 + 断言收集 + 证据落盘
 *
 * 隔离原则：
 *  - loadConfig 全自定义注入（绝不读宿主 ~/.pi/agent/mcp.json——宿主配置含真实凭证）
 *  - 纯编程用例：隔离 agentDir（mkdtemp），连宿主 settings/auth 都不可见
 *  - 模型驱动用例：agentDir 用宿主真实目录（读默认 provider/model），cwd 仍隔离
 *    —— 与生产集成形态一致（PiAgentAdapter 默认 getAgentDir()）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const RESULTS_DIR = path.join(import.meta.dirname, "results");

/** 单条断言记录 */
export interface Assertion {
  name: string;
  pass: boolean;
  detail?: string;
}

export class Case {
  readonly assertions: Assertion[] = [];
  constructor(readonly caseName: string) {}

  assert(name: string, pass: boolean, detail?: unknown): boolean {
    const detailStr = detail === undefined ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail);
    this.assertions.push({ name, pass, detail: detailStr });
    const mark = pass ? "PASS" : "FAIL";
    console.log(`  [${mark}] ${name}${detailStr ? ` -- ${detailStr}` : ""}`);
    return pass;
  }

  /** SDK 行为发现：记 WARN 供报告，不影响 pass */
  warn(name: string, detail?: unknown): void {
    const detailStr = detail === undefined ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail);
    this.assertions.push({ name: `[WARN] ${name}`, pass: true, detail: detailStr });
    console.log(`  [WARN] ${name}${detailStr ? ` -- ${detailStr}` : ""}`);
  }

  get allPass(): boolean {
    return this.assertions.every((a) => a.pass);
  }
}

/** 落盘证据并打印汇总；全部通过返回 0，否则 1 */
export function finish(cases: Case[]): number {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const summary = {
    timestamp: new Date().toISOString(),
    cases: cases.map((c) => ({ name: c.caseName, pass: c.allPass, assertions: c.assertions })),
    allPass: cases.every((c) => c.allPass),
  };
  const file = path.join(RESULTS_DIR, `${cases.map((c) => c.caseName).join("-").replace(/[^\w-]/g, "_")}.json`);
  fs.writeFileSync(file, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\n== 结果: ${summary.allPass ? "全部通过" : "存在失败"} ==  证据: ${file}`);
  return summary.allPass ? 0 : 1;
}

/** 临时隔离目录（cwd + 可选 agentDir） */
export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** fixture server 的 McpServerEntry 构造 */
export interface FixtureOverrides {
  exposure?: "direct" | "codemode" | "deferred" | "hidden";
  toolExposure?: Record<string, "direct" | "codemode" | "deferred" | "hidden">;
  enabled?: boolean;
}

export function fixtureEntry(name: string, overrides: FixtureOverrides = {}) {
  const serverPath = path.join(import.meta.dirname, "..", "fixture", "echo-mcp-server.mjs");
  return {
    name,
    config: {
      type: "stdio" as const,
      command: process.execPath,
      args: [serverPath],
      env: { FIXTURE_PID_LOG: process.env.FIXTURE_PID_LOG ?? "" },
      ...overrides,
    },
    source: "fixture",
    scope: "extension" as const,
  };
}

/** 自定义 loadConfig：只返回给定 entries（绝不触宿主 mcp.json） */
export function makeLoadConfig(entries: ReturnType<typeof fixtureEntry>[]) {
  return () => ({ servers: entries, errors: [], autoEnableCodemode: true });
}

/** 轮询等待工具注册完成（MCP 连接后台异步，bindExtensions 返回时未必完成） */
export async function waitForTools(
  session: { getActiveToolNames(): string[] },
  predicate: (names: string[]) => boolean,
  timeoutMs = 15000,
): Promise<string[]> {
  const start = Date.now();
  for (;;) {
    const names = session.getActiveToolNames();
    if (predicate(names) || Date.now() - start > timeoutMs) return names;
    await new Promise((r) => setTimeout(r, 200));
  }
}

export interface SessionOptions {
  /** MCP server entries（经 makeLoadConfig 注入） */
  entries: ReturnType<typeof fixtureEntry>[];
  /** 是否装配 codemode/tool_search 工厂（M0-1 起默认 true） */
  withCodemode?: boolean;
  /** 模型驱动用例置 true：agentDir 用宿主真实目录（读 provider/model 凭证） */
  needModel?: boolean;
  /** 额外扩展工厂（如 M0-3 的拦截测试扩展） */
  extraFactories?: unknown[];
}

/** 创建隔离会话并 bindExtensions；返回 session 与诊断信息 */
export async function createSession(opts: SessionOptions) {
  const cwd = makeTempDir("m0-cwd-");
  const agentDir = opts.needModel ? getAgentDir() : makeTempDir("m0-agentdir-");
  const factories: unknown[] = [
    createMcpExtension({ loadConfig: makeLoadConfig(opts.entries) }),
  ];
  if (opts.withCodemode !== false) {
    factories.push(createCodemodeExtension({ mode: "on" }), createToolSearchExtension());
  }
  if (opts.extraFactories) factories.push(...opts.extraFactories);

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true, // 递归防护保持：磁盘扩展零加载，仅显式工厂
    extensionFactories: factories,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();

  const settingsManager = SettingsManager.create(cwd);
  settingsManager.applyOverrides({ defaultTools: ["+codemode", "+tool_search"] });

  const { session } = await createAgentSession({
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
  });
  await session.bindExtensions({});
  return { session, loader, cwd, agentDir };
}
