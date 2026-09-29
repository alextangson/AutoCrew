// 诊断减负：node probe-slim.mjs <full|slim>，打印 session/new 上报的模型/配置/模式与每轮 usage_update、压缩事件
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import * as acp from "@agentclientprotocol/sdk";
const variant = process.argv[2];
const cwd = homedir() + "/.cache/autocrew-yt/acp-spike/slim";
mkdirSync(cwd, { recursive: true });
const bin = new URL("./node_modules/.bin/claude-agent-acp", import.meta.url).pathname;
const child = spawn(bin, [], { cwd, stdio: ["pipe", "pipe", "ignore"] });
const events = [];
const conn = new acp.ClientSideConnection(() => ({
  requestPermission: async (p) => ({ outcome: { outcome: "selected", optionId: p.options[0].optionId } }),
  sessionUpdate: async (n) => { const u = n.update; if (["usage_update", "compaction_update"].includes(u.sessionUpdate) || (u.sessionUpdate === "tool_call" && /compact/i.test(u.title ?? ""))) events.push(JSON.stringify(u).slice(0, 200)); } }),
  acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { session: { compaction: {} } } });
const options = variant === "slim" ? { settingSources: ["project"], strictMcpConfig: true } : {};
const s = await conn.newSession({ cwd, mcpServers: [], _meta: { claudeCode: { options } } });
console.log("models", JSON.stringify(s.models)?.slice(0, 400));
console.log("configOptions", JSON.stringify(s.configOptions?.map((c) => [c.id, c.currentValue, c.options?.map?.((o) => o.value ?? o.id)]))?.slice(0, 600));
console.log("modes", JSON.stringify(s.modes?.availableModes?.map((m) => m.id)));
for (const t of ["reply ok", "list the MCP servers/tools and skills you have, names only, one line"]) {
  const r = await conn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: t }] });
  console.log("turn", r.stopReason, events.splice(0).join(" | "));
}
child.kill("SIGKILL"); process.exit(0);
