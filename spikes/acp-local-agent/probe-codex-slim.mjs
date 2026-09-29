// 诊断 Codex 减负：ARGS 传 -c 覆盖；打印 MCP 启动、session 配置项、首轮用量
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import * as acp from "@agentclientprotocol/sdk";
const cwd = homedir() + "/.cache/autocrew-yt/acp-spike/codex-slim";
mkdirSync(cwd, { recursive: true });
const bin = new URL("./node_modules/.bin/codex-acp", import.meta.url).pathname;
const args = JSON.parse(process.env.ARGS ?? "[]");
const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, RUST_LOG: "info" } });
let err = ""; child.stderr.on("data", (d) => { err += d; });
const ev = []; const text = [];
const conn = new acp.ClientSideConnection(() => ({
  requestPermission: async (p) => ({ outcome: { outcome: "selected", optionId: p.options.find((o) => o.kind === "reject_once").optionId } }),
  sessionUpdate: async (n) => { const u = n.update; if (u.sessionUpdate === "agent_message_chunk") text.push(u.content?.text ?? ""); if (u.sessionUpdate === "usage_update") ev.push(`${u.used}/${u.size}`); } }),
  acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
const t = Date.now();
const s = await conn.newSession({ cwd, mcpServers: [] });
console.log("new ms", Date.now() - t, "modes", JSON.stringify(s.modes?.availableModes?.map((m) => m.id)), "current", s.modes?.currentModeId);
console.log("config", JSON.stringify(s.configOptions?.map((c) => [c.id, c.currentValue, c.options?.map?.((o) => o.value)])));
await conn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: "List the names of every MCP server/tool namespace you can call, one line, no other text. Do not call tools." }] });
console.log("reply:", text.join("").slice(0, 300)); console.log("usage:", ev.slice(-1));
console.log("mcp startup:", [...err.matchAll(/McpStartupUpdate\(McpStartupUpdateEvent \{ server: "([^"]+)"/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).join(","));
child.kill("SIGKILL"); process.exit(0);
