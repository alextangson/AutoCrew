// 诊断 codex 权限模式：列 modes/configOptions，切到只读后看 shell 是否发 request_permission
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { homedir } from "node:os";
import { existsSync, rmSync } from "node:fs";
import * as acp from "@agentclientprotocol/sdk";
const [bin, mode, policy] = process.argv.slice(2);
const cwd = homedir() + "/.cache/autocrew-yt/acp-spike/probe";
rmSync(cwd + "/deny.txt", { force: true });
const child = spawn(bin, (process.env.ARGS ?? "").split(" ").filter(Boolean), { cwd, stdio: ["pipe", "pipe", "ignore"] });
const perms = [];
const conn = new acp.ClientSideConnection(() => ({
  requestPermission: async (p) => { perms.push(p.options.map((o) => o.optionId + ":" + o.kind)); const o = p.options.find((x) => x.kind.startsWith(policy)); return { outcome: { outcome: "selected", optionId: o.optionId } }; },
  sessionUpdate: async () => {} }), acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
const s = await conn.newSession({ cwd, mcpServers: [] });
console.log("modes", JSON.stringify(s.modes?.availableModes?.map((m) => m.id)), "current", s.modes?.currentModeId);
console.log("config", JSON.stringify(s.configOptions?.map((c) => [c.id, c.currentValue, c.options?.map?.((o) => o.value)])));
if (mode) await conn.setSessionMode({ sessionId: s.sessionId, modeId: mode });
await conn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: "Run this exact shell command: echo no > deny.txt . If rejected, stop, do not retry." }] });
console.log("perms", JSON.stringify(perms), "fileExists", existsSync(cwd + "/deny.txt"));
child.kill("SIGKILL"); process.exit(0);
