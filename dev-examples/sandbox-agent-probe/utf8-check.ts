/**
 * UTF-8 实测：中文 PRD 内容写入/读回/编辑（本项目资产多为中文，M1.2 回归用）
 * 用法：npx tsx utf8-check.ts
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { WorkspaceFileService } from "../../packages/execution/src/index.js"

const root = await mkdtemp(path.join(tmpdir(), "pcm-utf8-real-"))
try {
  const svc = new WorkspaceFileService(root)
  const prd = `# 游戏需求文档

## 一、核心玩法

玩家通过 **麻将规则** 进行对局，包含 碰、杠、吃 三种操作。🎮

| 属性 | 说明 |
|---|---|
| 血量 | 100 ✅ |
| 技能 | 火球术 🔥 |
`
  await svc.write("PRD.md", prd)
  const back = await svc.read("PRD.md")
  const size = (await stat(path.join(root, "PRD.md"))).size
  const expected = Buffer.byteLength(prd, "utf8")
  console.log("往返一致:", back === prd)
  console.log("字节数正确:", size === expected, `(实际 ${size}, 期望 ${expected})`)
  await svc.edit("PRD.md", "血量 | 100 ✅", "血量 | 500 ✅")
  const edited = await svc.read("PRD.md")
  console.log("中文编辑成功:", edited.includes("血量 | 500 ✅") && edited.includes("火球术 🔥"))
  const ok = back === prd && size === expected && edited.includes("血量 | 500 ✅")
  console.log(ok ? "\nUTF-8 实测通过" : "\nUTF-8 实测失败")
  process.exitCode = ok ? 0 : 1
} finally {
  await rm(root, { recursive: true, force: true })
}
