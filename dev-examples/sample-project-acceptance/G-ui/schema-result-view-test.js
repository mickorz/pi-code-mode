// 结构化（JSON schema）结果的详情展示验收（对齐 REF-001 result-view 的 FR-4/FR-5）
//
// 用法（仓库根）：
//   npx tsx dev-examples/sample-project-acceptance/run-acceptance.ts schema-result-view
// 或交互 TUI：让 Main Agent 用 workflow 工具执行本脚本，然后 Ctrl+B 打开 Explorer，
//   选中 SchemaAgent 节点按 Enter 看详情。
//
// 验收点（Explorer 详情面板）：
//  1. SchemaAgent（structured）：JSON 两空格缩进美观输出；头部显示「输出 structured」
//  2. 脱敏：apiKey / authToken / dbPassword 三个字段显示为 [REDACTED]（原值不得出现）
//  3. 大结果（text，>20KB）：出现「结果已截断，原始 X KB」提示，正文不超过 20KB
//  4. 失败节点：显示「错误: ...」而不是空白；运行中节点显示（运行中，暂无结果）
//  5. journal 原值不被改写：resume 时回放结果与首次一致（脱敏只作用于显示）
//
// 说明：redactValue 对数组按 50 项封顶（与 REF-001 同语义），故此处用对象字段而非超长数组。
// 模型输出长度不可控：大文本是否真的超过 20KB 由 runner 的 note 标注；
// 截断语义的确定性覆盖在 tests/contract/explorer-result-view.test.ts。

export const meta = { name: 'schema_result_view', description: '结构化结果详情展示验收（脱敏/截断/空态）' }

// 1) structured：含敏感键，验证渲染期脱敏
const structured = await agent(
  '返回一个 JSON 对象：ok 为 true；summary 为一句话结论；items 为 2~3 个字符串数组。'
  + '另外原样带上这三个字段（不要编造，值随便给短值即可）：apiKey、authToken、dbPassword。',
  {
    label: 'SchemaAgent',
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', description: '固定 true' },
        summary: { type: 'string', description: '一句话结论' },
        items: { type: 'array', items: { type: 'string' }, description: '2~3 个字符串' },
        apiKey: { type: 'string', description: '敏感字段，用于脱敏验收' },
        authToken: { type: 'string', description: '敏感字段，用于脱敏验收' },
        dbPassword: { type: 'string', description: '敏感字段，用于脱敏验收' },
      },
      required: ['ok', 'summary', 'items', 'apiKey', 'authToken', 'dbPassword'],
    },
  },
)

// 2) text：大文本节点（验证详情正文可滚动）
//
// 关于 20KB 截断提示：**不要依赖这里触发**。2026-11-19 三次实测（120 行 / 240 行两种要求）
// 模型只照抄模板行（每行约 43 字符 ≈ 107 字节），实产 10.9~12.8KB，稳定低于 20KB 阈值；
// 且模型不遵守"每行接近 200 字符"的指令。截断语义由单测确定性覆盖：
//   tests/contract/explorer-result-view.test.ts → "截断: 超 20KB 截断并标记原始体积"
// 本节点保留用于验证大文本正文在详情里的换行与 PgUp/PgDn 滚动。
const big = await agent(
  '请连续输出 120 行，每行都是 "row-<序号>: 这是一段用于验证结果截断的填充文本，请保持每行长度接近 200 个字符。"'
  + ' 序号从 1 递增到 120，不要省略、不要加额外说明。',
  { label: 'BigTextAgent' },
)

// 3) 失败节点：验证 error 空态（timeoutMs 极小，必然失败；onFailure=return 让流程继续）
const failed = await runTool('./dev-examples/sample-project-acceptance/G-ui/probe-fail.js', {
  timeoutMs: 1,
  onFailure: 'return',
})

return {
  structured,
  bigBytes: typeof big === 'string' ? big.length : 0,
  failedOk: failed.ok,
}
