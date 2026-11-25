/**
 * M1 adapter 级 e2e：真实模型验证受控工具层（fast 档，2026-11-25 用户确认系列延续）
 *
 * 验收项（执行计划 v3 M1）：
 *   E1 Agent 能写工作区文件（write_file 真实落盘）
 *   E2 Agent 能读回文件（read_file 内容正确）
 *   E3 Agent 能发起 run_command（M1 fail-closed：blocked 文案，无宿主机执行）
 *   E4 不再暴露 pi 内置 bash（模型尝试调用应失败/不存在；工具面只有受控 4 工具）
 *   E5 结构化输出契约不回归（schema 路径正常）
 *
 * 用法：npx tsx e2e.ts
 */
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PiAgentAdapter } from "../../packages/adapter/src/pi-agent-adapter.js"
import { loadModelTiers } from "../../packages/engine/src/agent/model-tiers.js"

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "pcm-m1-e2e-"))
  const results: Array<[string, boolean, string]> = []
  const check = (id: string, ok: boolean, detail: string) => results.push([id, ok, detail])

  try {
    const tiers = loadModelTiers({ projectDir: path.resolve(import.meta.dirname, "../..") })
    const fast = tiers.fast as string
    if (typeof fast !== "string") throw new Error("model-tiers fast 档缺失")
    const adapter = new PiAgentAdapter({ defaultCwd: root })

    // E1/E2：写文件 + 读回（结构化输出验证 E5 一并覆盖）
    const r1 = await adapter.execute(
      {
        prompt:
          `请调用 write_file 工具，把内容 "m1-e2e-ok" 写入 e2e.txt。然后调用 read_file 读回 e2e.txt。` +
          `最后按 schema 输出一个 JSON 对象 {"written": true, "readBack": "<读到的内容>"}。`,
        model: fast,
        cwd: root,
        outputSchema: {
          type: "object",
          properties: { written: { type: "boolean" }, readBack: { type: "string" } },
          required: ["written", "readBack"],
        },
      },
      { executionId: `e2e-${randomUUID().slice(0, 8)}`, runId: "run-m1-e2e" },
    )
    const onDisk = await readFile(path.join(root, "e2e.txt"), "utf8").catch(() => "<未落盘>")
    check("E1 write_file 真实落盘", onDisk === "m1-e2e-ok", `onDisk=${JSON.stringify(onDisk)}`)
    const structured = r1.status === "ok" && r1.output.type === "structured" ? r1.output.value : undefined
    check(
      "E2+E5 readBack 与结构化输出",
      !!structured && (structured as { readBack?: string }).readBack === "m1-e2e-ok",
      `status=${r1.status} structured=${JSON.stringify(structured).slice(0, 120)}`,
    )

    // E3：run_command fail-closed（blocked 文案）
    const r2 = await adapter.execute(
      {
        prompt: `请调用 run_command 工具执行 "echo hello"，然后把工具返回的原始文本一字不差地放在 JSON 的 "raw" 字段输出：{"raw": "<工具返回文本>"}`,
        model: fast,
        cwd: root,
        outputSchema: {
          type: "object",
          properties: { raw: { type: "string" } },
          required: ["raw"],
        },
      },
      { executionId: `e2e-${randomUUID().slice(0, 8)}`, runId: "run-m1-e2e" },
    )
    const raw = r2.status === "ok" && r2.output.type === "structured" ? String((r2.output.value as { raw?: string }).raw ?? "") : ""
    check(
      "E3 run_command M1 fail-closed",
      raw.includes("blocked") && raw.includes("sandbox"),
      `raw=${JSON.stringify(raw.slice(0, 140))}`,
    )

    // E4：内置 bash 不可用（模型被要求用 bash 工具时应报告它不存在）
    const r3 = await adapter.execute(
      {
        prompt:
          `请尝试调用名为 "bash" 的工具执行 "echo hi"（如果该工具不存在，工具调用会报错，这是预期行为）。` +
          `然后输出 JSON {"bashAvailable": <true|false>}，其中 true 仅当 bash 工具确实可调用且返回了结果。`,
        model: fast,
        cwd: root,
        outputSchema: {
          type: "object",
          properties: { bashAvailable: { type: "boolean" } },
          required: ["bashAvailable"],
        },
      },
      { executionId: `e2e-${randomUUID().slice(0, 8)}`, runId: "run-m1-e2e" },
    )
    const bashAvailable =
      r3.status === "ok" && r3.output.type === "structured"
        ? (r3.output.value as { bashAvailable?: boolean }).bashAvailable
        : undefined
    check("E4 内置 bash 不可用", bashAvailable === false, `bashAvailable=${JSON.stringify(bashAvailable)} status=${r3.status}`)

    let failed = 0
    for (const [id, ok, detail] of results) {
      console.log(`${ok ? "PASS" : "FAIL"}  ${id}  | ${detail}`)
      if (!ok) failed++
    }
    console.log(failed === 0 ? "\nM1 e2e 全部通过" : `\nM1 e2e 失败 ${failed} 项`)
    process.exitCode = failed === 0 ? 0 : 1
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error("e2e 崩溃:", e)
  process.exitCode = 2
})
