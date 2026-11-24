// 命令目录架构守卫（规范见项目 CLAUDE.md「extensions 命令开发规范」）：
//   - 一命令一文件/目录：commands/<命令名>.ts 或 commands/<命令名>/（目录入口必须 index.ts，Windows 下与同名 .ts 不能共存）
//   - 主入口 pi-code-mode.ts 只做装配：每个命令文件/目录必须被它 import
//   - 目录内每个子命令文件必须被该目录 index.ts 路由引用（新增子命令忘接路由表 -> 此测试失败提醒）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = path.resolve(HERE, "../../extensions/commands");
const MAIN_ENTRY = path.resolve(HERE, "../../extensions/pi-code-mode.ts");

/** 豁免文件：目录的路由入口与共享契约，不要求被路由引用 */
const EXEMPT = new Set(["index.ts", "types.ts"]);

/** 提取源码中的相对导入路径（from "./xxx.js"） */
function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) out.push(m[1]);
  return out;
}

test("命令规范: 顶层命令文件与命令目录都被主入口装配", () => {
  const mainImports = importsOf(fs.readFileSync(MAIN_ENTRY, "utf-8"));
  for (const entry of fs.readdirSync(COMMANDS_DIR)) {
    const full = path.join(COMMANDS_DIR, entry);
    if (entry.endsWith(".ts")) {
      const name = entry.replace(/\.ts$/, "");
      assert.ok(
        mainImports.some((i) => i.includes(`/commands/${name}.js`)),
        `命令文件 commands/${entry} 未被 pi-code-mode.ts 装配（主入口缺 registerXxxCommand 接入）`,
      );
    } else if (fs.statSync(full).isDirectory()) {
      assert.ok(fs.existsSync(path.join(full, "index.ts")), `命令目录 commands/${entry}/ 缺 index.ts 路由入口`);
      assert.ok(
        mainImports.some((i) => i.includes(`/commands/${entry}/index.js`)),
        `命令目录 commands/${entry}/ 未被 pi-code-mode.ts 装配`,
      );
    }
  }
});

test("命令规范: 目录内每个子命令文件都被该目录 index 路由引用", () => {
  for (const entry of fs.readdirSync(COMMANDS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(COMMANDS_DIR, entry.name);
    const indexImports = importsOf(fs.readFileSync(path.join(dir, "index.ts"), "utf-8"));
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".ts") || EXEMPT.has(f)) continue;
      const name = f.replace(/\.ts$/, "");
      assert.ok(
        indexImports.some((i) => i.endsWith(`/${name}.js`)),
        `子命令文件 ${entry.name}/${f} 未被 index.ts 引用（加入 subcommands 路由表）`,
      );
    }
  }
});

// ---- optimize 子命令必须被路由（曾出现「导入但未注册」导致 /workflows optimize 报未知子命令）----
test("optimize 子命令已注册到 /workflows 路由表", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "../../extensions/commands/workflows/index.ts"), "utf8")
  assert.match(src, /import\s*\{\s*optimizeSubcommand\s*\}/, "必须导入 optimizeSubcommand")
  assert.match(src, /optimize:\s*optimizeSubcommand/, "必须注册到 subcommands 路由表（否则命令不可达）")
})
