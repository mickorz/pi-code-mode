// 预热检查：最小 prompt 验证 provider 可用（走与验收 runner 相同的 PiAgentAdapter 通道）
import { PiAgentAdapter } from "../../src/adapter/pi-agent-adapter.js"
const adapter = new PiAgentAdapter({ defaultCwd: process.cwd() })
const t0 = Date.now()
const r = await adapter.execute(
  { prompt: "只回复 ok", label: "warmup" },
  { executionId: "warmup-" + Date.now(), onEvent: () => {} }
)
console.log(JSON.stringify({ status: r.status, reply: String(r.output ?? r.text ?? "").slice(0, 50), ms: Date.now() - t0 }))
