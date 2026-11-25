/**
 * M2-W3b —— 真实 CocosCreator GUI 构建在 MXC 沙盒内执行（对照沙盒外基线）
 *
 * 目的：验证真实构建链在沙盒内能否完成，并逐项记录权限缺口。
 * 不修改生产代码：仅通过 SrtCommandExecutor 发起一条真实构建命令。
 *
 * 用法（Node ^24.21 || ^26.8）：
 *   "…\v26.11.1\node.exe" --import ./node_modules/tsx/dist/loader.mjs m2-w3b-real-build.ts
 */
import path from "node:path"
import { readdir, rm, stat } from "node:fs/promises"

import {
  WorkspaceRegistry,
  createCommandExecutor,
  ensureWorkspace,
} from "../../packages/execution/src/index.js"

const CLI = "E:/CocosProjects/CocosCLI"
const PROJECT = path.join(CLI, "examples", "cocos_example_proj")
const CREATOR = "D:/CocosSofts/Creator/3.7.3/CocosCreator.exe"
const OUT = path.join(PROJECT, "build", "web-mobile")

const registry = new WorkspaceRegistry()
// 构建需要两个工作区：CLI 工具目录 + 工程目录（真实构建时二者都会被动）
ensureWorkspace(registry, CLI)
ensureWorkspace(registry, PROJECT)
const executor = createCommandExecutor({ platform: "win32", windowsBackend: "mxc", workspaceRegistry: registry })

async function tally(dir: string): Promise<number> {
  let n = 0
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) n += await tally(p)
    else if (e.isFile()) n++
  }
  return n
}

// 清掉沙盒外基线产物，确保接下来看到的产物一定来自沙盒内构建
const before = await tally(OUT)
console.log(`清理前产物文件数: ${before}`)
await rm(OUT, { recursive: true, force: true })
console.log(`已清理 ${OUT}，准备在沙盒内构建\n`)

const t0 = Date.now()
const r = await executor.execute({
  // 真实构建命令：cocoscli build web-mobile
  command: `cmd /c set COCOS_CREATOR_PATH=${CREATOR} && node dist/index.js build web-mobile examples/cocos_example_proj`,
  cwd: CLI,
  timeoutMs: 900000, // 15 分钟：编辑器启动 + 资源导入 + 打包
  // 工具链只读路径（真实场景应由项目配置提供，非模型输入）
  readOnlyPaths: [path.dirname(CREATOR)],
  // 编辑器缓存/日志目录（构建专用权限档；真实场景由项目配置提供）
  writePaths: [
    path.join(process.env.APPDATA ?? "", "CocosCreator"),
    path.join(process.env.LOCALAPPDATA ?? "", "CocosCreator"),
    path.join(process.env.USERPROFILE ?? "", ".CocosCreator"),
    path.join(process.env.USERPROFILE ?? "", ".CocosDashboard"),
  ],
  // 真实构建需要编辑器许可校验/资源下载网络（构建专用权限档，M2-W4 落地）
  allowedDomains: ["cocos.com"],
})

const elapsed = Math.round((Date.now() - t0) / 1000)
const after = await tally(OUT)
const outExists = (await stat(OUT).catch(() => undefined)) !== undefined

console.log(`\n========== 结果 ==========`)
console.log(`exit: ${r.exitCode}  timedOut: ${r.timedOut ?? false}  耗时: ${elapsed}s`)
console.log(`产物目录存在: ${outExists}  产物文件数: ${after}`)
console.log(`\n--- stdout 尾部 ---`)
console.log(r.stdout.split("\n").slice(-25).join("\n"))
if (r.stderr.trim()) {
  console.log(`\n--- stderr 尾部 ---`)
  console.log(r.stderr.split("\n").slice(-20).join("\n"))
}

const ok = !r.blocked && (r.stdout.includes("构建成功") || after > 0)
console.log(`\n判定: ${ok ? "沙盒内构建完成（需比对产物）" : "沙盒内构建未完成"}`)
process.exitCode = ok ? 0 : 1
