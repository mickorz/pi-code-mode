// 预热检查：最小 prompt 验证 provider 可用（走与验收 runner 相同的 PiAgentAdapter 通道）
// 用法: npx tsx warmup.mjs
import { PiAgentAdapter } from "../../src/adapter/pi-agent-adapter.js"
const adapter = new PiAgentAdapter({ defaultCwd: process.cwd() })
const t0 = Date.now()
const r = await adapter.execute({ prompt: "只回复 ok" }, { executionId: "warmup-" + Date.now(), runId: "warmup" })
console.log(
  JSON.stringify({
    status: r.status,
    reply: r.status === "ok" ? String(r.output.value).slice(0, 50) : r.error?.message ?? "(无)",
    usage: r.usage ?? "(缺省)",
    ms: Date.now() - t0,
  }),
)
