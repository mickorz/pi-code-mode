export const meta = { id: "smoke_no_agent", name: "smoke_no_agent" }
const r = await runTool("./dev-examples/runner-smoke/echo.js")
return { toolStdout: r.stdout ?? r }
