#!/usr/bin/env node
/**
 * pi-code-mode 开发者快捷指令。
 *
 * 用法（任意项目目录下执行）：
 *   pi-code-mode install   把开发中的 pi-code-mode 插件按本地路径装进当前项目（项目级）
 *   pi-code-mode remove    从当前项目卸载
 *   pi-code-mode path      打印插件仓库绝对路径
 *   pi-code-mode test      干净房间一次性测试：pi -ne -e <repo>
 *
 * 实现：直接读写当前项目 .pi/settings.json 的 packages 数组（绝对路径条目）。
 * 不走 `pi install/remove` CLI —— 规避其在未信任项目中的修改限制与
 * 相对路径匹配 bug（/tmp 软链目录下 pi 会存 ../../ 形式且 remove 匹配失败）。
 * pi 对 packages 本地路径的解析：settings 文件内相对路径或绝对路径均合法。
 *
 * 更新循环：改 src → npm run build（类型检查）→ 重启 pi（宿主经 jiti 直载 TS 源）。
 */
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PKG_ID = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")).name;

function usage() {
  console.log(`pi-code-mode 开发者快捷指令（插件仓库：${REPO_ROOT}）

用法（在目标项目目录下执行）：
  pi-code-mode install    按本地路径把开发中的插件装进当前项目（项目级 .pi/settings.json）
  pi-code-mode remove     从当前项目卸载
  pi-code-mode path       打印插件仓库绝对路径
  pi-code-mode test       干净房间一次性测试：pi -ne -e <repo>

分析工具：
  pi-code-mode analyze <脚本>  [--json|--md] [--write]  静态分析 workflow（调用图/风险/估算）
  pi-code-mode plan validate <plan.json>              校验 Plan（Schema/Profile 边界/指纹/过期）

装完后在当前项目启动 pi，首次会弹 project trust 确认，授权一次永久生效。
分析工具（本 CLI）：
  pi-code-mode analyze <脚本> [--json|--md] [--write]
  pi-code-mode plan validate <plan.json>

插件工具：workflow / workflow_control / workflow_analyze / plan_validate / schedule_*；
命令：/workflows /schedule。
更新插件：插件仓库改 src → npm run build → 重启本项目的 pi。`);
}

/** settings 文件里条目（可能相对/绝对）解析为绝对路径 */
const resolveEntry = (entry, settingsDir) => resolve(settingsDir, entry);

function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (e) {
    console.error(`✗ 无法解析 ${settingsPath}：${e.message}`);
    process.exit(1);
  }
}

function writeSettings(settingsPath, settings) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

const cmd = process.argv[2] ?? "help";
const cwd = process.cwd();
const settingsPath = resolve(cwd, ".pi/settings.json");
const settingsDir = dirname(settingsPath);

/** 转发分析类子命令给 src 下的 TS 实现（经 tsx 运行，避免 bin 里重复实现分析逻辑） */
function runTsCli(tsRelPath, exportName, args) {
  const script = resolve(REPO_ROOT, tsRelPath);
  if (!existsSync(script)) {
    console.error(`✗ 缺少实现文件：${script}（先 npm run build 或在仓库根运行）`);
    return 1;
  }
  // 用仓库内的 tsx 直接跑一个小驱动脚本，避免 bin 依赖 TS 编译产物路径
  const moduleUrl = pathToFileURL(script).href;
  const driver = `
import { ${exportName} } from ${JSON.stringify(moduleUrl)};
const code = await ${exportName}(process.argv.slice(1));
process.exit(typeof code === "number" ? code : 0);
`;
  const r = spawnSync(
    process.execPath,
    [resolve(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"), "--input-type=module", "-e", driver, ...args],
    { cwd: cwd, stdio: "inherit", env: process.env },
  );
  if (r.error) {
    console.error(`✗ 运行分析器失败：${r.error.message}`);
    return 1;
  }
  return r.status ?? 0;
}

switch (cmd) {
  case "analyze": {
    process.exitCode = runTsCli("src/tools/workflow-analyze-tool.ts", "runAnalyzeCli", process.argv.slice(3));
    break;
  }
  case "plan": {
    const sub = process.argv[3];
    if (sub === "validate") {
      process.exitCode = runTsCli("src/tools/plan-tool.ts", "runPlanValidateCli", process.argv.slice(4));
    } else {
      console.error("用法：pi-code-mode plan validate <plan.json>");
      process.exitCode = 2;
    }
    break;
  }
  case "install": {
    if (resolve(cwd) === REPO_ROOT) {
      console.log("当前目录就是插件仓库本身，已通过 .pi/settings.json 自托管，无需再装。");
      break;
    }
    // 校验仓库确是合法 pi 包（防止误指到残缺目录）
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
    if (!manifest.pi?.extensions && !manifest.pi?.skills) {
      console.error(`✗ ${REPO_ROOT} 的 package.json 缺少 pi.extensions/pi.skills，不是合法 pi 包。`);
      process.exit(1);
    }
    const settings = readSettings(settingsPath);
    settings.packages ??= [];
    const already = settings.packages.find(
      (p) => typeof p === "string" && resolveEntry(p, settingsDir) === REPO_ROOT,
    );
    if (already) {
      console.log(`✓ ${PKG_ID} 已安装（${settingsPath} → ${already}），无需重复。`);
      break;
    }
    settings.packages.push(REPO_ROOT);
    writeSettings(settingsPath, settings);
    console.log(
      [
        `✓ 已安装 ${PKG_ID}（本地路径直连：${REPO_ROOT}）`,
        `  写入 ${settingsPath}`,
        "下一步：",
        "  1. 在当前项目启动 pi，首次会弹 project trust 确认 → 授权一次永久生效",
        "  2. 工具：workflow / workflow_control / schedule_*；命令：/workflows /schedule",
        "  3. 更新插件：在插件仓库改 src → npm run build → 重启本项目的 pi",
      ].join("\n"),
    );
    break;
  }
  case "remove": {
    if (resolve(cwd) === REPO_ROOT) {
      console.log("插件仓库本身的自托管配置（.pi/settings.json）请直接删除该文件卸载。");
      break;
    }
    const settings = readSettings(settingsPath);
    const kept = (settings.packages ?? []).filter(
      (p) => !(typeof p === "string" && resolveEntry(p, settingsDir) === REPO_ROOT),
    );
    if (kept.length === (settings.packages ?? []).length) {
      console.log(`当前项目未安装 ${PKG_ID}，无需卸载。`);
      break;
    }
    if (kept.length === 0) {
      delete settings.packages;
      if (Object.keys(settings).length === 0) {
        if (existsSync(settingsPath)) unlinkSync(settingsPath);
        console.log("✓ 已卸载（packages 清空，移除 .pi/settings.json）。");
        break;
      }
    } else {
      settings.packages = kept;
    }
    writeSettings(settingsPath, settings);
    console.log("✓ 已卸载。");
    break;
  }
  case "path": {
    console.log(REPO_ROOT);
    break;
  }
  case "test": {
    console.log(`→ 干净房间一次性测试（不写配置）：pi -ne -e ${REPO_ROOT}`);
    const r = spawnSync("pi", ["-ne", "-e", REPO_ROOT], { cwd: REPO_ROOT, stdio: "inherit" });
    if (r.error) console.error(`✗ 找不到 pi 命令：${r.error.message}`);
    else process.exitCode = r.status ?? 0;
    break;
  }
  case "help":
  case "--help":
  case "-h":
  default: {
    if (cmd !== "help" && cmd !== "--help" && cmd !== "-h") {
      console.log(`未知子命令：${cmd}\n`);
      process.exitCode = 1;
    }
    usage();
  }
}
