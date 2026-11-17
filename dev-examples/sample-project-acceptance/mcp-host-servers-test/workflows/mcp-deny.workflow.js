// 通道：子 Agent 调用（M2）——验证 denyTools 在子 Agent 侧的 hidden 不可达语义（模型视角 searchTools 找不到）
export const meta = {
  name: "mcp_deny_test",
  description: "denyTools 优先级验收：allow 放开全量但 deny 精确封锁 webReader",
}

log("开始：denyTools 优先级测试")

const r = await agent(
  'Try to call the mcp__web_reader__webReader tool with url "https://example.com". It may need loading via tool_search first. If the tool is not found or cannot be called, return exactly: TOOL BLOCKED. Otherwise return the page title.',
  {
    label: "被 deny 的 agent",
    tools: {
      mcp: {
        enabled: true,
        servers: ["web-reader"],
        allowTools: ["web-reader:*"],
        denyTools: ["web-reader:webReader"],
      },
    },
  },
)

return { result: r }
