// 验收用确定性工具：被 schema-result-view-test.js 以极小 timeoutMs 调用，必然失败
// 不写文件、不改状态，只 sleep 到被超时杀掉
setTimeout(() => process.exit(0), 5000);
