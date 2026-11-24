/**
 * apps/ 入口的可运行检查：
 *  - CLI 参数解析（--args/--concurrency/未知选项）
 *  - relay 的 /health、/runs、SSE 推送（真实 http 服务 + 临时 journal 目录）
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { parseArgv } from "../../apps/cli/src/index.js"
import { createRelayServer } from "../../apps/relay/src/index.js"

test("CLI 参数解析：--args/--concurrency/--json 与非法输入", () => {
  const parsed = parseArgv(["run", "quality-loop", "--args", '{"a":1}', "--concurrency", "4", "--json"])
  assert.equal(parsed.command, "run")
  assert.deepEqual(parsed.positional, ["quality-loop"])
  assert.deepEqual(parsed.args, { a: 1 })
  assert.equal(parsed.concurrency, 4)
  assert.equal(parsed.json, true)

  assert.throws(() => parseArgv(["run", "x", "--args", "{bad"]), /不是合法 JSON/)
  assert.throws(() => parseArgv(["run", "x", "--concurrency", "0"]), /正整数/)
  assert.throws(() => parseArgv(["run", "x", "--nope"]), /未知选项/)
})

const tmpProject = () => fs.mkdtempSync(path.join(os.tmpdir(), "pcm-relay-"))

const get = (port: number, pathname: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    http
      .get({ port, host: "127.0.0.1", path: pathname }, (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => (body += chunk))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
      })
      .on("error", reject)
  })

test("relay：/health 与 /runs 能读到 journal 目录里的 run 摘要", async () => {
  const cwd = tmpProject()
  const journalDir = path.join(cwd, ".pi", "workflows", "journal")
  fs.mkdirSync(journalDir, { recursive: true })
  fs.writeFileSync(
    path.join(journalDir, "run-1.json"),
    JSON.stringify({ metadata: { workflowId: "demo", status: "ok", startedAt: 1, endedAt: 2 }, observability: { agents: [] } }),
  )

  const server = createRelayServer({ cwd, port: 0 })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port

  assert.equal((await get(port, "/health")).status, 200)
  const runs = JSON.parse((await get(port, "/runs")).body) as Array<{ runId: string; metadata?: { workflowId?: string } }>
  assert.equal(runs.length, 1)
  assert.equal(runs[0]?.runId, "run-1")
  assert.equal(runs[0]?.metadata?.workflowId, "demo")

  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test("relay：新写入的 journal 会通过 SSE 推送", async () => {
  const cwd = tmpProject()
  const journalDir = path.join(cwd, ".pi", "workflows", "journal")
  fs.mkdirSync(journalDir, { recursive: true })

  const server = createRelayServer({ cwd, port: 0 })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port

  const received = new Promise<string>((resolve, reject) => {
    const req = http.get({ port, host: "127.0.0.1", path: "/events" }, (res) => {
      res.setEncoding("utf8")
      res.on("data", (chunk: string) => {
        const line = chunk.split("\n").find((l) => l.startsWith("data: "))
        if (line) {
          req.destroy()
          resolve(line.slice("data: ".length))
        }
      })
    })
    req.on("error", reject)
    // 等连接建立后再写文件，避免文件写在订阅之前
    setTimeout(() => {
      fs.writeFileSync(
        path.join(journalDir, "run-2.json"),
        JSON.stringify({ metadata: { workflowId: "pushed", status: "ok" }, observability: {} }),
      )
    }, 200)
  })

  const payload = JSON.parse(await received) as { runId: string; snapshot: { metadata: { workflowId: string } } }
  assert.equal(payload.runId, "run-2")
  assert.equal(payload.snapshot.metadata.workflowId, "pushed")

  await new Promise<void>((resolve) => server.close(() => resolve()))
})
