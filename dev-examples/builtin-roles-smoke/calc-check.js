// dev-examples 沙盒：calc.js 的最小自检脚本（非正式代码）
import assert from "node:assert"

import { add, sub, mul, div } from "./calc.js"

// add 应返回两数之和
assert.strictEqual(add(2, 3), 5)
// sub 应返回两数之差
assert.strictEqual(sub(5, 3), 2)
// mul 应返回两数之积
assert.strictEqual(mul(3, 4), 12)
// div 应返回两数之商
assert.strictEqual(div(6, 3), 2)

console.log("calc-check 通过：add(2,3)===5，sub(5,3)===2，mul(3,4)===12，div(6,3)===2")
