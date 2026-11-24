// ⚠️ 故意写坏的 workflow：用于验证 /workflows anal 的规则召回
//
// 预期命中（共 8 条规则）：
//   TIMEOUT-001  所有 agent 都不写 timeoutMs，也没有 run 级超时
//   RETRY-001    retries: 2（确定性任务不需要重试两次）
//   INPUT-001    allRequirements 以 JSON.stringify 整体注入 2 个 agent
//   SERIAL-002   buggyA / buggyB 相邻、互不引用
//   CONC-002     parallel(parts.map(...))，parts 来自运行时 args
//   DET-001      prompt 是「统计/去重」这类确定性任务
//   IO-001       prompt 要求模型用 read 工具读文件
//   REC-001      估算任务量 >= 20 且完全没有 phase 边界
//
// 请勿照此模式写生产 workflow。
export const meta = {
  id: 'buggy-demo',
  name: 'buggy_demo',
  description: '故意有缺陷的示例：用于验证 Analyzer 规则召回',
}

const A = args || {}

// 缺陷 INPUT-001：大对象 + 整体性语义名，后面会被 JSON.stringify 注入多次
const allRequirements = {
  items: new Array(80).fill(0).map((_, i) => `需求条目-${i}：这是一段足够长的描述，用来撑大对象体积`),
}

// 缺陷 CONC-002：分片数来自运行时 args，静态不可知
const parts = A.parts || Array.from({ length: 48 }, (_, i) => `part-${i}`)

// 缺陷 CONC-002 + RETRY-001 + TIMEOUT-001：
//   parallel 里是动态分片；每个 agent 有 retries: 2 但没有 timeoutMs
const results = await parallel(
  parts.map((p) => () =>
    agent(`只回复 ok：${p}`, {
      retries: 2,
    }),
  ),
)

// 缺陷 SERIAL-002：两个调用源码相邻、返回值互不引用
// 缺陷 DET-001：第一个 prompt 是「统计 + 去重」，本该用 JS 确定性完成
// 缺陷 TIMEOUT-001：仍然没有 timeoutMs
const buggyA = await agent('统计 items 的数量并去重，只回复数字', { retries: 2 })

// 缺陷 IO-001：让模型用 read 工具读文件并原样返回（确定性 IO）
const buggyB = await agent('用 read 工具读取 requirements.md 并原样返回全文', { retries: 2 })

// 缺陷 INPUT-001：把同一个大对象 JSON.stringify 注入两个不同 agent
const first = await agent(`分析以下需求集合：${JSON.stringify(allRequirements)}`, { retries: 2 })
const second = await agent(`复核以下需求集合：${JSON.stringify(allRequirements)}`, { retries: 2 })

// 缺陷 REC-001：总任务量 ≈ 48 + 4 = 52 >= 20，且全文没有任何 phase()
return { results, buggyA, buggyB, first, second }
