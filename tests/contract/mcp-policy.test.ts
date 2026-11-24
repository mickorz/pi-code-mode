/**
 * M1 契约测试：filterMcpConfig 六行为 + 通配符交叉矩阵（纯函数，无模型）
 * 对应执行计划第三节验收标准
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import { filterMcpConfig, splitToolSpec } from "../../packages/mcp/src/mcp-policy.js"

function makeBase() {
  return {
    servers: [
      {
        name: "game",
        config: { type: "stdio" as const, command: "node", args: ["server.js"] },
        source: "test",
        scope: "global" as const,
      },
      {
        name: "docs",
        config: { type: "stdio" as const, command: "node", args: ["docs.js"] },
        source: "test",
        scope: "global" as const,
      },
    ],
    errors: ["pre-existing-config-error"],
    autoEnableCodemode: true,
    projectConfig: "/proj/.pi/mcp.json",
  }
}

test("默认拒绝：enabled=true 且无 servers 白名单 → 空集", () => {
  const out = filterMcpConfig(makeBase(), { enabled: true })
  assert.equal(out.servers.length, 0)
  assert.equal(out.errors.length, 1) // base 自带 errors 保留
})

test("默认拒绝：enabled=false → 空集", () => {
  const out = filterMcpConfig(makeBase(), { enabled: false, servers: ["game"] })
  assert.equal(out.servers.length, 0)
})

test("server 白名单：只保留白名单内 server，白名单外不连接", () => {
  const out = filterMcpConfig(makeBase(), { enabled: true, servers: ["game"] })
  assert.deepEqual(out.servers.map((s) => s.name), ["game"])
  assert.equal(out.errors.length, 1)
})

test("白名单中不存在的 server 名 → 记入 errors 不产出", () => {
  const out = filterMcpConfig(makeBase(), { enabled: true, servers: ["game", "ghost"] })
  assert.deepEqual(out.servers.map((s) => s.name), ["game"])
  assert.equal(out.errors.length, 2) // base 1 + ghost 1
  assert.match(out.errors[1]!, /ghost/)
})

test("工具级授权独立生效：server 默认 hidden + allowTools 显式开放（codemode 配置值）", () => {
  const out = filterMcpConfig(makeBase(), {
    enabled: true,
    servers: ["game"],
    allowTools: ["game:echo", "game:get_time"],
  })
  const game = out.servers[0]!.config as Record<string, unknown>
  assert.equal(game.exposure, "hidden")
  const te = game.toolExposure as Record<string, string>
  assert.equal(te["echo"], "codemode")
  assert.equal(te["get_time"], "codemode")
  assert.equal(Object.keys(te).length, 2) // 未授权工具不占 key（继承 server hidden）
})

test("deny 精确名压过 server direct（反向用例，M0-2C 语义）", () => {
  const out = filterMcpConfig(makeBase(), {
    enabled: true,
    servers: ["game"],
    exposure: { game: "direct" },
    denyTools: ["game:echo"],
  })
  const game = out.servers[0]!.config as Record<string, unknown>
  assert.equal(game.exposure, "direct")
  const te = game.toolExposure as Record<string, string>
  assert.equal(te["echo"], "hidden")
})

test("deny 精确名压过 allow 通配符（键序：deny 精确名在最前，exact 优先）", () => {
  const out = filterMcpConfig(makeBase(), {
    enabled: true,
    servers: ["game"],
    allowTools: ["game:*"],
    denyTools: ["game:delete_rules"],
  })
  const te = out.servers[0]!.config.toolExposure as Record<string, string>
  assert.equal(te["delete_rules"], "hidden")
  assert.equal(te["*"], "codemode")
  const keys = Object.keys(te)
  assert.ok(keys.indexOf("delete_rules") < keys.indexOf("*"), `deny 精确名应在模式前: ${keys.join(",")}`)
})

test("deny 模式压过 allow 模式（键序：deny 模式在 allow 模式前，首个匹配获胜）", () => {
  const out = filterMcpConfig(makeBase(), {
    enabled: true,
    servers: ["game"],
    allowTools: ["game:update_*", "game:get_*"],
    denyTools: ["game:update_*"],
  })
  const te = out.servers[0]!.config.toolExposure as Record<string, string>
  assert.equal(te["update_*"], "hidden")
  assert.equal(te["get_*"], "codemode")
  const keys = Object.keys(te)
  assert.ok(keys.indexOf("update_*") < keys.indexOf("get_*"), `deny 模式应在 allow 模式前: ${keys.join(",")}`)
})

test("通配符模式原样透传（不做字符串匹配，匹配由 pi 执行）", () => {
  const out = filterMcpConfig(makeBase(), {
    enabled: true,
    servers: ["game"],
    allowTools: ["game:get_*"],
  })
  const te = out.servers[0]!.config.toolExposure as Record<string, string>
  assert.equal(te["get_*"], "codemode")
})

test("exposure 覆盖透传：显式指定 server exposure 时开放工具用覆盖值", () => {
  const out = filterMcpConfig(makeBase(), {
    enabled: true,
    servers: ["game"],
    allowTools: ["game:echo"],
    exposure: { game: "direct" },
  })
  const game = out.servers[0]!.config as Record<string, unknown>
  assert.equal(game.exposure, "direct")
  const te = game.toolExposure as Record<string, string>
  assert.equal(te["echo"], "direct")
})

test("base 元数据保留（errors/autoEnableCodemode/projectConfig）", () => {
  const out = filterMcpConfig(makeBase(), { enabled: true, servers: ["game"] })
  assert.deepEqual(out.errors, ["pre-existing-config-error"])
  assert.equal(out.autoEnableCodemode, true)
  assert.equal(out.projectConfig, "/proj/.pi/mcp.json")
})

test("非法规范名（缺冒号/空段）→ 记 errors 且不生效", () => {
  const out = filterMcpConfig(makeBase(), {
    enabled: true,
    servers: ["game"],
    allowTools: ["no-colon", "game:", ":tool"],
  })
  assert.equal(out.errors.length, 4) // base 1 + 非法 3
  assert.equal(out.servers[0]!.config.toolExposure, undefined)
})

test("splitToolSpec：第一个冒号切分（tool 含冒号时剩余部分归 tool）", () => {
  assert.deepEqual(splitToolSpec("game:a:b"), { server: "game", tool: "a:b" })
  assert.equal(splitToolSpec("nocolon"), null)
  assert.equal(splitToolSpec(":tool"), null)
  assert.equal(splitToolSpec("server:"), null)
})

test("deny 对未白名单 server 的条目被忽略", () => {
  const out = filterMcpConfig(makeBase(), {
    enabled: true,
    servers: ["game"],
    allowTools: ["docs:echo"],
  })
  const game = out.servers[0]!.config as Record<string, unknown>
  // docs 不在白名单，其 allow 条目应被忽略；game 无工具级配置保持原样
  assert.equal(game.toolExposure, undefined)
  assert.equal(game.exposure, undefined)
})

test("defaultServers 'all'：未声明 servers → 全部 enabled server（workflow 直调默认开启语义）", () => {
  const base = makeBase()
  const out = filterMcpConfig(base, { enabled: true }, { defaultServers: "all" })
  assert.deepEqual(out.servers.map((s) => s.name), ["game", "docs"])
})

test("defaultServers 'all'：disabled server 仍被排除", () => {
  const base = makeBase()
  ;(base.servers[0]!.config as Record<string, unknown>).enabled = false
  const out = filterMcpConfig(base, { enabled: true }, { defaultServers: "all" })
  assert.deepEqual(out.servers.map((s) => s.name), ["docs"])
})

test("defaultServers 'all'：声明了 servers 时仍按白名单过滤", () => {
  const out = filterMcpConfig(makeBase(), { enabled: true, servers: ["docs"] }, { defaultServers: "all" })
  assert.deepEqual(out.servers.map((s) => s.name), ["docs"])
})
