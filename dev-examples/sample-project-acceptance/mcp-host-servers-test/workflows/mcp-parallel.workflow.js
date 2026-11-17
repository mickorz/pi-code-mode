// 通道：子 Agent 调用（M2）——多 Agent 并行编排，各持不同 server 白名单；直调形态做不到模型级并行任务
export const meta = {
  name: "mcp_parallel_test",
  description: "多 Agent 并行编排验收：两个 Agent 各自持不同 server 白名单并行调用 MCP",
}

log("开始：多 Agent 并行 MCP 编排测试")

const [page, repo] = await parallel([
  // Agent A：只授权 web-reader
  () =>
    agent(
      'The tool mcp__web_reader__webReader is not declared yet. Use the tool_search tool to search "webReader", load it, then call it with url "https://example.com". Return only the page title you found.',
      {
        label: "web-reader agent",
        tools: {
          mcp: { enabled: true, servers: ["web-reader"], allowTools: ["web-reader:*"] },
        },
      },
    ),
  // Agent B：只授权 zread
  () =>
    agent(
      'The tool mcp__zread__get_repo_structure is not declared yet. Use the tool_search tool to search "repo structure", load it, then call it with repo_name "earendil-works/pi". Return any one top-level entry name you saw.',
      {
        label: "zread agent",
        tools: {
          mcp: { enabled: true, servers: ["zread"], allowTools: ["zread:*"] },
        },
      },
    ),
])

log("两个 Agent 均已完成")

return { page, repo }
