// 通道：子 Agent 调用（M2）——agent() 起子会话，模型经 tool_search 发现并调用 MCP；适合模型自主探索的任务
export const meta = {
  name: "mcp_web_reader_test",
  description: "web-reader MCP 工具调用验收：Agent 按白名单调用宿主 web-reader 读网页",
}

log("开始：web-reader MCP 调用测试")

const page = await agent(
  'The tool mcp__web_reader__webReader is not declared yet. Use the tool_search tool to search "webReader", load it, then call it with url "https://example.com". Return only the page title you found.',
  {
    label: "web-reader 调用",
    tools: {
      mcp: {
        enabled: true,
        servers: ["web-reader"],
        allowTools: ["web-reader:*"],
      },
    },
  },
)

return { page }
