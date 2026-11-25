# FileHandle 读写共用同一 fd 时 writeFile 从尾部追加（fd position 语义坑）

> 发现日期：2026-11-25
> 发现场景：M1.1 TOCTOU 加固（packages/execution/src/files/workspace-file-service.ts）
> 影响组件：WorkspaceFileService 的 write/edit（fd 化后引入）

## 问题现象

edit（读后写同一 FileHandle）替换内容后，文件变成 `'hello worldgo'` 而不是 `'goodbye world'`——新内容"追加"在了旧内容之后，又被 truncate 截断，产生错乱结果。

```ts
const content = await handle.readFile({ encoding: "utf8" }) // fd position -> 文件尾
// ...计算 next...
await handle.writeFile(next, { encoding: "utf8" })          // 从 fd 当前位置（尾部）写入！
await handle.truncate(next.length)
```

## 排查过程

contract 测试断言 `read === "goodbye world"` 失败，实际 `'hello worldgo'`：
- 原 "hello world"（11 字节）readFile 后 position=11
- writeFile("goodbye world") 从 position 11 追加 → "hello worldgoodbye world"
- truncate(13) 截到 13 字节 → "hello worldgo"

## 根因

Node `FileHandle.writeFile(data)` / `readFile()` 走 fd 的**当前位置**（没有独立 offset 参数）。`readFile` 读完把 position 推到文件尾；随后的 `writeFile` 不是"从 0 覆盖"而是"从当前位置写"。`fsPromises.writeFile(path)`（按路径）每次重新 open，position 恒 0，所以按路径写从没暴露过这个语义——fd 化（TOCTOU 防护要求打开后不再走路径解析）后才踩中。

## 解决方案

fd 上写全量内容必须**显式 position 0**：

```ts
await handle.write(next, 0, "utf8")   // write(string, position, encoding)
await handle.truncate(next.length)    // 收缩到新长度（覆盖语义）
```

## 预防与注意事项

1. 同一 FileHandle 上"读后写"（edit 语义）必须 `write(data, 0, ...)`；`writeFile` 只适用于 fd 刚打开（position=0）且未读过。
2. `FileHandle.write(string, position, encoding)` 的显式 position **不移动** fd 位置，可反复定点写。
3. `FileHandle.writeFile` / `readFile` 支持 options.signal；`write(string, ...)` 不支持（取消交给外层 await 点）。
4. fd 化文件服务（防 TOCTOU）时，每个"读写组合"都过一遍 position 语义，并配 roundtrip 测试（写-读-改-读回），本坑就是该测试抓出来的。
