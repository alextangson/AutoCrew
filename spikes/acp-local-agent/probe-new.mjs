// 诊断 session/new：node probe-new.mjs <adapterBin> <withMcp:0|1>
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { homedir } from "node:os";
import * as acp from "@agentclientprotocol/sdk";
const [bin, withMcp] = process.argv.slice(2);
const cwd = homedir() + "/.cache/autocrew-yt/acp-spike/probe";
const child = spawn(bin, [], { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, RUST_LOG: "info" } });
let err = ""; child.stderr.on("data", (d) => { err += d; });
const conn = new acp.ClientSideConnection(() => ({ requestPermission: async () => ({ outcome: { outcome: "cancelled" } }), sessionUpdate: async () => {} }), acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
const t = Date.now();
const init = await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
console.log("init", init.agentInfo?.version, Date.now() - t);
const mcpServers = withMcp === "1" ? [{ type: "http", name: "x", url: "http://127.0.0.1:9/mcp", headers: [] }] : [];
try {
  const s = await Promise.race([conn.newSession({ cwd, mcpServers }), new Promise((_, r) => setTimeout(() => r(new Error("timeout 90s")), 90000))]);
  console.log("new ok", s.sessionId, Date.now() - t);
  const lo = await conn.loadSession({ sessionId: s.sessionId, cwd, mcpServers }).then(() => "ok", (e) => "err " + JSON.stringify(e));
  console.log("load (same proc)", lo);
} catch (e) { console.log("new fail", String(e.message ?? JSON.stringify(e))); }
console.log("stderr tail:", err.slice(-1500));
child.kill("SIGKILL"); process.exit(0);
