/**
 * P0-1 verifier 真执行契约（2026-11-23）
 *
 * 背景：此前 runVerifier 是无条件 ok:true 的 stub，
 * 用户传 --verify-cmd 但命令从未执行，质量门却 pass → 可能把未验证代码写进生产。
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { parseVerifierCommand, renderVerifier, runVerifierCommand } from "../../packages/engine/src/optimizer/verifier-runner.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "verifier-"))

test("parseVerifierCommand：简单命令拆 argv", () => {
  assert.deepEqual(parseVerifierCommand("npm test"), { file: "npm", args: ["test"] })
  assert.deepEqual(parseVerifierCommand("node verify.mjs --strict"), { file: "node", args: ["verify.mjs", "--strict"] })
})

test("parseVerifierCommand：sh -c 整串保留为一个参数", () => {
  const r = parseVerifierCommand('sh -c "cat a.txt | grep ok"')
  assert.deepEqual(r, { file: "sh", args: ["-c", "cat a.txt | grep ok"] })
})

test("parseVerifierCommand：空命令报错（不静默通过）", () => {
  const r = parseVerifierCommand("   ")
  assert.ok("error" in r)
})

test("runVerifierCommand：退出码 0 → ok", async () => {
  const cwd = tmp()
  const r = await runVerifierCommand({ command: `node -e "process.exit(0)"`, cwd })
  assert.equal(r.ok, true, r.note)
  assert.equal(r.exitCode, 0)
})

test("runVerifierCommand：退出码 1 → 失败（不是通过）", async () => {
  const cwd = tmp()
  const r = await runVerifierCommand({ command: `node -e "process.exit(1)"`, cwd })
  assert.equal(r.ok, false)
  assert.equal(r.exitCode, 1)
  assert.match(r.note, /失败/)
})

test("runVerifierCommand：命令不存在 → 失败", async () => {
  const cwd = tmp()
  const r = await runVerifierCommand({ command: "definitely-not-a-real-cmd-xyz", cwd })
  assert.equal(r.ok, false)
  assert.match(r.note, /不存在|启动失败/)
})

test("runVerifierCommand：超时 → 失败（不能当通过）", async () => {
  const cwd = tmp()
  const r = await runVerifierCommand({ command: `node -e "setTimeout(()=>{},10000)"`, cwd, timeoutMs: 300 })
  assert.equal(r.ok, false)
  assert.match(r.note, /超时/)
})

test("runVerifierCommand：cwd 生效（在工作区跑，能读到工作区文件）", async () => {
  const cwd = tmp()
  fs.writeFileSync(path.join(cwd, "marker.txt"), "ok", "utf8")
  const r = await runVerifierCommand({
    command: `node -e "const fs=require('fs');process.exitString=1;process.exit(fs.existsSync('marker.txt')?0:1)"`,
    cwd,
  })
  assert.equal(r.ok, true, "必须在传入 cwd 下执行")
})

test("runVerifierCommand：捕获 stdout 供审计", async () => {
  const cwd = tmp()
  const r = await runVerifierCommand({ command: `node -e "console.log('hello-verifier')"`, cwd })
  assert.equal(r.ok, true)
  assert.match(r.stdout, /hello-verifier/)
})

test("renderVerifier：包含命令、结论、退出码、stdout", async () => {
  const cwd = tmp()
  const r = await runVerifierCommand({ command: `node -e "console.log('x')"`, cwd })
  const md = renderVerifier(r, "node -e ...")
  assert.match(md, /- verifier：/)
  assert.match(md, /结论：通过/)
  assert.match(md, /退出码：0/)
  assert.match(md, /stdout/)
})
