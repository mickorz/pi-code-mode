// 模型串解析契约（Step 1 前置修复：provider/model[:thinking] -> Model 对象，注入 fake runtime 无 SDK 依赖）
import test from "node:test"
import assert from "node:assert/strict"
import { resolveModelSpec } from "../../src/adapter/model-spec.js"

function fakeRuntime(table: Record<string, string | undefined>) {
  return {
    getModel: (provider: string, modelId: string) => {
      const id = table[`${provider}/${modelId}`]
      return id ? ({ id: modelId, provider } as any) : undefined
    },
    getModels: (provider?: string) =>
      Object.entries(table)
        .filter(([k, v]) => v && (!provider || k.startsWith(`${provider}/`)))
        .map(([k, v]) => ({ id: k.split("/")[1], provider: k.split("/")[0], actual: v } as any)),
  } as any
}

test("resolve: provider/model 精确命中", async () => {
  const r = await resolveModelSpec("openai/gpt-x", fakeRuntime({ "openai/gpt-x": "resolved" }))
  assert.equal(r.model?.provider, "openai")
  assert.equal(r.model?.id, "gpt-x")
  assert.equal(r.thinkingLevel, undefined)
})

test("resolve: :thinking 后缀解析", async () => {
  const r = await resolveModelSpec("anthropic/claude:high", fakeRuntime({ "anthropic/claude": "r" }))
  assert.equal(r.model?.id, "claude")
  assert.equal(r.thinkingLevel, "high")
})

test("resolve: 无 provider 前缀按 id 全表兜底", async () => {
  const r = await resolveModelSpec("gpt-x", fakeRuntime({ "openai/gpt-x": "resolved" }))
  assert.equal(r.model?.provider, "openai")
  assert.equal(r.warning, undefined)
})

test("resolve: 未命中返回 warning 且不带 model（调用方回退默认模型）", async () => {
  const r = await resolveModelSpec("openai/nope", fakeRuntime({ "openai/gpt-x": "resolved" }))
  assert.equal(r.model, undefined)
  assert.match(r.warning!, /不在模型注册表中/)
})
