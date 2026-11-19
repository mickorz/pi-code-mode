// 真实模型验证：流式 partial 是否按节流推送、尾部是否递增、终态后是否停止
import { PiAgentAdapter } from "../../src/adapter/pi-agent-adapter.js"
import { agentAdapterToRunner } from "../../src/adapter/agent-adapter.js"

const runner = agentAdapterToRunner(new PiAgentAdapter({ defaultCwd: process.cwd() }))
const samples: Array<{ t: number; len: number; tail: string }> = []
const t0 = Date.now()
const out = await runner.run(
  "请用大约 200 字说明「事件驱动」与「轮询」的区别，分 3 段输出，不要用列表。",
  {
    label: "stream-probe",
    executionId: "probe:0:1",
    onPartial: (tail) => samples.push({ t: Date.now() - t0, len: tail.length, tail: tail.slice(-30) }),
  },
)
console.log("总耗时ms:", Date.now() - t0, "| partial 次数:", samples.length)
console.log("首次:", samples[0]?.t, "ms len=", samples[0]?.len)
console.log("末次:", samples.at(-1)?.t, "ms len=", samples.at(-1)?.len)
console.log("采样点:", samples.map((s) => `${s.t}ms/${s.len}字`).join("  "))
console.log("最终结果长度:", String(out.value).length, "| 尾部样例:", JSON.stringify(samples.at(-1)?.tail))
