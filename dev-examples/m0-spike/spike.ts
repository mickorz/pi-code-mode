// M0-3/4 pi 子会话实证脚本
// 逐项跑 execute/cancel/timeout/工具禁用/递归防护/usage 形态，输出 JSON 结果
// 用法: npx tsx spike.ts [--only <case>]
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const results: Record<string, any> = {};
const cwd = process.cwd();
const agentDir = `${process.env.USERPROFILE || process.env.HOME}/.pi/agent`;

function log(name: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${name}: ${msg}`);
}

/** 创建隔离子会话: 内存会话 + noExtensions(防递归第一道) + 继承用户模型认证 */
async function newSession(opts: Record<string, any> = {}) {
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.create(cwd, agentDir),
    resourceLoader: loader,
    ...opts,
  });
  return { session, extensionsResult };
}

/** 收集 agent_end 终态: 文本 + usage 原始形态 */
function collect(session: AgentSession) {
  return new Promise<{ text: string; usageRaw: any[]; settled: any; toolCalls: string[] }>((resolve) => {
    let text = "";
    const usageRaw: any[] = [];
    const toolCalls: string[] = [];
    let settled: any = null;
    const unsub = session.subscribe((e: any) => {
      if (e.type === "message_end" && e.message?.role === "assistant") {
        for (const c of e.message.content ?? []) {
          if (c.type === "text") text += c.text;
        }
        if (e.message.usage) usageRaw.push(e.message.usage);
        for (const c of e.message.content ?? []) {
          if (c.type === "toolCall") toolCalls.push(c.name ?? c.toolCallId);
        }
      }
      if (e.type === "agent_settled") {
        settled = e;
        unsub();
        resolve({ text: text.trim(), usageRaw, settled: { aborted: e.aborted }, toolCalls });
      }
    });
  });
}

/** 挑一个长任务 prompt（cancel/timeout 用） */
const LONG_TASK = "从 1 数到 300，每行一个数字，不要省略任何数字，不要输出其他内容。";

// ---------- 1. execute-text: 基础调用 + usage 形态 ----------
async function caseExecuteText() {
  const name = "execute-text";
  try {
    const { session } = await newSession();
    const done = collect(session);
    const t0 = Date.now();
    await session.prompt("只回复 ok 两个字母，不要其他内容。");
    const r = await done;
    results[name] = {
      status: r.text.toLowerCase().includes("ok") ? "PASS" : "FAIL",
      reply: r.text.slice(0, 60),
      usageRawCount: r.usageRaw.length,
      usageRawFirst: r.usageRaw[0] ?? null,
      elapsedMs: Date.now() - t0,
      toolCalls: r.toolCalls,
    };
  } catch (e: any) {
    results[name] = { status: "ERROR", error: String(e?.message ?? e) };
  }
}

// ---------- 2. execute-cancel: 在途取消 ----------
async function caseExecuteCancel() {
  const name = "execute-cancel";
  try {
    const { session } = await newSession();
    const done = collect(session);
    const p = session.prompt(LONG_TASK);
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = Date.now();
    await session.abort();
    await Promise.race([p, new Promise((r) => setTimeout(r, 15000))]);
    const r = await done;
    results[name] = {
      status: r.settled?.aborted ? "PASS" : "FAIL",
      settledAborted: r.settled?.aborted,
      abortToSettleMs: Date.now() - t0,
      // usage 应缺省或不完整: 取消时禁止 0 冒充
      usageRawCount: r.usageRaw.length,
      partialTextLen: r.text.length,
    };
  } catch (e: any) {
    results[name] = { status: "ERROR", error: String(e?.message ?? e) };
  }
}

// ---------- 3. execute-timeout: Engine 侧计时 + abort ----------
async function caseExecuteTimeout() {
  const name = "execute-timeout";
  try {
    const { session } = await newSession();
    const done = collect(session);
    const p = session.prompt(LONG_TASK);
    // Engine 统一计时, 超时触发 abort (契约 3.2)
    await new Promise((r) => setTimeout(r, 2000));
    await session.abort();
    await Promise.race([p, new Promise((r) => setTimeout(r, 15000))]);
    const r = await done;
    results[name] = {
      status: r.settled?.aborted ? "PASS" : "FAIL",
      settledAborted: r.settled?.aborted,
      note: "Engine 侧超时复用 abort 通道, 与 cancel 同机制",
    };
  } catch (e: any) {
    results[name] = { status: "ERROR", error: String(e?.message ?? e) };
  }
}

// ---------- 4. tools-none: 全工具禁用 (noTools all + 空白名单) ----------
async function caseToolsNone() {
  const name = "tools-none";
  try {
    const { session } = await newSession({ noTools: "all", tools: [], excludeTools: ["*"] });
    const done = collect(session);
    await session.prompt("请执行 shell 命令 echo 123 并告诉我输出。如果你没有任何工具可用，直接回复 NO-TOOLS。");
    const r = await done;
    results[name] = {
      status: r.toolCalls.length === 0 ? "PASS" : "FAIL",
      toolCalls: r.toolCalls,
      reply: r.text.slice(0, 100),
    };
  } catch (e: any) {
    results[name] = { status: "ERROR", error: String(e?.message ?? e) };
  }
}

// ---------- 5. tools-wildcard: 通配符 exclude 单独禁 bash ----------
async function caseToolsWildcard() {
  const name = "tools-wildcard";
  try {
    const { session } = await newSession({ excludeTools: ["bash*", "edit*", "write*"] });
    const done = collect(session);
    await session.prompt("请用工具执行命令 echo 123。如果你没有执行命令的工具，直接回复 NO-BASH，不要尝试其他方式。");
    const r = await done;
    results[name] = {
      status: !r.toolCalls.includes("bash") ? "PASS" : "FAIL",
      toolCalls: r.toolCalls,
      reply: r.text.slice(0, 100),
    };
  } catch (e: any) {
    results[name] = { status: "ERROR", error: String(e?.message ?? e) };
  }
}

// ---------- 6. recursive-guard: noExtensions 不加载宿主扩展 ----------
async function caseRecursiveGuard() {
  const name = "recursive-guard";
  try {
    const { extensionsResult } = await newSession();
    const exts = (extensionsResult?.extensions ?? extensionsResult?.loaded ?? []).map((x: any) => x.path ?? x.name ?? String(x));
    // 用户环境装有大量扩展(如 pi-dynamic-workflows), noExtensions 下应一个都不加载
    results[name] = {
      status: exts.length === 0 ? "PASS" : "WARN",
      loadedExtensions: exts,
      note: exts.length === 0 ? "noExtensions 生效, 宿主扩展零加载, 递归编排通道关闭" : "存在已加载扩展, 需人工检查是否含 workflow 系工具",
    };
  } catch (e: any) {
    results[name] = { status: "ERROR", error: String(e?.message ?? e) };
  }
}

// ---------- 7. structured-basic: prompt 要求 JSON 的基础透传 ----------
async function caseStructuredBasic() {
  const name = "structured-basic";
  try {
    const { session } = await newSession({ noTools: "all", tools: [], excludeTools: ["*"] });
    const done = collect(session);
    await session.prompt('只输出一个 JSON 对象, 格式 {"ok": true, "n": <你回复的字符数>}, 不要输出任何其他内容。');
    const r = await done;
    let parsed: any = null;
    try {
      parsed = JSON.parse(r.text.replace(/^```(json)?|```$/g, "").trim());
    } catch {
      /* 模型没给纯 JSON */
    }
    results[name] = {
      status: parsed?.ok === true ? "PASS" : "FAIL",
      parsed,
      raw: r.text.slice(0, 120),
      note: "P0 仅验证基础结构化透传可行; typebox 校验+修复循环属 M2",
    };
  } catch (e: any) {
    results[name] = { status: "ERROR", error: String(e?.message ?? e) };
  }
}

// ---------- 执行 ----------
const cases: Record<string, () => Promise<void>> = {
  "execute-text": caseExecuteText,
  "execute-cancel": caseExecuteCancel,
  "execute-timeout": caseExecuteTimeout,
  "tools-none": caseToolsNone,
  "tools-wildcard": caseToolsWildcard,
  "recursive-guard": caseRecursiveGuard,
  "structured-basic": caseStructuredBasic,
};

const list = only ? [only] : Object.keys(cases);
for (const name of list) {
  const fn = cases[name];
  if (!fn) {
    console.error(`未知用例: ${name}`);
    process.exit(2);
  }
  log(name, "开始");
  await fn();
  log(name, `结束 -> ${results[name].status}`);
}

console.log("\n==== M0 SPIKE 结果 ====");
console.log(JSON.stringify(results, null, 2));
