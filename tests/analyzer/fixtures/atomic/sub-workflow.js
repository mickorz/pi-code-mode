// 期望：workflow 子流程调用节点识别
const spec = await workflow('./1-spec.js')
const design = await workflow('./2-design.js', { brief: spec.brief })
return design
