// 通道：子 Agent 调用（M2）——同上；确定性单点调用请改用直调形态（见 mcp-direct.workflow.js）
export const meta = {
  name: "mcp_zread_test",
  description: "zread MCP 工具调用验收：Agent 按白名单读取 GitHub repo 结构",
}

log("开始：zread MCP 调用测试")

const repo = await agent(
  'The tool mcp__zread__get_repo_structure is not declared yet. Use the tool_search tool to search "repo structure", load it, then call it with repo_name "earendil-works/pi". Return any one top-level entry name you saw.',
  {
    label: "zread 调用",
    tools: {
      mcp: {
        enabled: true,
        servers: ["zread"],
        allowTools: ["zread:*"],
      },
    },
  },
)

return { repo }
