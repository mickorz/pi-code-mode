/**
 * M0 预热：验证模型可用（CLAUDE.md 纪律：验收类长任务前先预热检查模型可用）
 * 最小 prompt "只回复 ok"，验证 SDK 会话（宿主 agentDir 凭证）能完成一次模型往返
 */
import { Case, createSession, finish, fixtureEntry } from "./lib/session-helper.js";

async function main() {
  const c = new Case("m0-warmup");
  console.log("== 模型预热 ==");
  const entries = [fixtureEntry("fix", { exposure: "direct" })];
  const { session } = await createSession({ entries, needModel: true });
  let reply = "";
  session.subscribe((event: any) => {
    if (event.type === "message_end" && event.message?.role === "assistant") {
      for (const part of event.message.content ?? []) {
        if (part.type === "text") reply += part.text;
      }
    }
  });
  await session.prompt("只回复 ok，不要说其他任何内容");
  const trimmed = reply.trim().toLowerCase();
  c.assert("模型返回响应", reply.length > 0, `reply=${reply.slice(0, 100)}`);
  c.assert("响应含 ok", trimmed.includes("ok"), `reply=${reply.slice(0, 100)}`);
  session.dispose();
  process.exit(finish([c]));
}

main().catch((e) => {
  console.error("预热失败:", e);
  process.exit(1);
});
