// 期望：SERIAL-001——三个 workflow 子流程构成 Explicit 依赖链
const spec = await workflow('./1-spec.js')
const design = await workflow('./2-design.js', { brief: spec.brief })
const code = await workflow('./3-code.js', { design: design.design })
return code
