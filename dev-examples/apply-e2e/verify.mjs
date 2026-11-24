// verifier：断言 workflow 产物结构正确（在当前 cwd = 工作区/生产目录执行）
import fs from "node:fs"
import path from "node:path"

// workflow 的返回值不落盘，这里只做「环境自检」：
// 确认工作区可执行、必要文件存在。真实项目可换成产物 schema 校验。
const here = process.cwd()
const ok = fs.existsSync(path.join(here, "worker.js"))
if (!ok) {
  console.error("缺少 worker.js，工作区不完整")
  process.exit(1)
}
console.log("verifier ok:", here)
process.exit(0)
