// 诊断 -c 键编码：带点的 MCP 名在 codex-acp 0.16.0 里怎么写才关得掉
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { homedir } from "node:os";
import * as acp from "@agentclientprotocol/sdk";
const args = JSON.parse(process.env.ARGS ?? "[]");
const child = spawn(new URL("./node_modules/.bin/codex-acp", import.meta.url).pathname, args, { cwd: homedir() + "/.cache/autocrew-yt", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, RUST_LOG: "info" } });
let err = ""; child.stderr.on("data", (d) => { err += d; });
const conn = new acp.ClientSideConnection(() => ({ requestPermission: async () => ({ outcome: { outcome: "cancelled" } }), sessionUpdate: async () => {} }), acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
try {
  await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  await conn.newSession({ cwd: homedir() + "/.cache/autocrew-yt", mcpServers: [] });
  await new Promise((r) => setTimeout(r, 3000));
  console.log("ok; mcp started:", [...err.matchAll(/McpStartupUpdate\(McpStartupUpdateEvent \{ server: "([^"]+)"/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).join(","));
} catch (e) { console.log("FAIL", e.message, err.slice(-300)); }
child.kill("SIGKILL"); process.exit(0);
