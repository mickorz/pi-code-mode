export const meta = {
  name: "mcp_direct_test",
  description: "M4 验收：workflow JS 内直接调用宿主 web-reader MCP（官方 code-mode 同款形态）",
  mcp: {
    enabled: true,
    servers: ["web-reader", "zread"],
    allowTools: ["web-reader:*", "zread:*"],
  },
}

log("开始：workflow 直调 MCP（不经子 Agent）")

// 形态一：mcp.call 显式调用（structuredContent 优先返回）
const page = await mcp.call("web-reader", "webReader", { url: "https://example.com" })

// 形态二：tools.mcp__<server>__<tool> proxy（官方 code-mode 同款；注意不要用 tools 作局部变量名遮蔽注入对象）
const zreadToolList = await mcp.listTools("zread")
const repoTool = zreadToolList.find((t) => t.name === "get_repo_structure")
const repo = repoTool
  ? await tools.mcp__zread__get_repo_structure({ repo_name: "earendil-works/pi" })
  : "get_repo_structure 不可用"

// 形态三：mcp.listServers / listTools 反射
const servers = mcp.listServers()

return { pageTitle: page, zreadTools: zreadToolList.map((t) => t.name), repo, servers }
