/**
 * 测试用的沙箱：临时 HOME、临时 AutoCrew 状态目录、假的 claude / codex 可执行文件（记下 argv，
 * 模拟 mcp add/list/remove、login status、-p），和一个只认宿主令牌的假 AutoCrew /mcp。
 * 真实的 ~/.claude.json、~/.codex、~/.workbuddy、~/.autocrew 一个字节都不碰（spec O12）。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookupHostToken } from "../host-tokens.js";
import { makeRunner, type HostEnv } from "./env.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** 假 claude：状态存在 $HOME/.claude.json（与真的同一位置），每次调用把 argv 追加到 $HOME/claude-argv.log */
const FAKE_CLAUDE = String.raw`
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const argv = process.argv.slice(2), home = process.env.HOME, file = path.join(home, ".claude.json");
fs.appendFileSync(path.join(home, "claude-argv.log"), JSON.stringify(argv) + "\n");
const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
const write = (d) => fs.writeFileSync(file, JSON.stringify(d, null, 2));
if (argv[0] === "-p") {
  const mode = process.env.FAKE_CLAUDE_PROBE || "ok";
  if (mode === "hang") setTimeout(() => {}, 1e9);
  else if (mode === "ok") console.log(JSON.stringify({ is_error: false, result: "OK" }));
  else if (mode === "login") { console.log(JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" })); process.exit(1); }
  else if (mode === "quota") { console.log(JSON.stringify({ is_error: true, result: "Claude AI usage limit reached" })); process.exit(1); }
  else { console.error("getaddrinfo ENOTFOUND api.anthropic.com"); process.exit(1); }
} else if (argv[0] === "mcp" && argv[1] === "add") {
  if (process.env.FAKE_CLAUDE_ADD_FAIL) { console.error("Error: something broke"); process.exit(1); }
  const dd = argv.indexOf("--"), head = argv.slice(2, dd), cmd = argv.slice(dd + 1);
  const env = {}; let name = null;
  for (let i = 0; i < head.length; i++) {
    if (head[i] === "-e") { const [k, ...v] = head[++i].split("="); env[k] = v.join("="); }
    else if (head[i] === "--scope" || head[i] === "-s") { if (head[++i] !== "user") process.exit(3); }
    else name = head[i];
  }
  const d = read(); d.mcpServers = d.mcpServers || {};
  if (d.mcpServers[name]) { console.error("MCP server " + name + " already exists in user config"); process.exit(1); }
  d.mcpServers[name] = { type: "stdio", command: cmd[0], args: cmd.slice(1), env }; write(d);
  console.log("Added stdio MCP server " + name + " to user config");
} else if (argv[0] === "mcp" && argv[1] === "remove") {
  const d = read(); if (!d.mcpServers || !d.mcpServers[argv[2]]) { console.error("No user-scoped MCP server found"); process.exit(1); }
  delete d.mcpServers[argv[2]]; write(d); console.log("Removed");
} else if (argv[0] === "mcp" && argv[1] === "list") {
  console.log("Checking MCP server health…\n");
  for (const [name, s] of Object.entries(read().mcpServers || {})) {
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n";
    const args = s.args || []; const r = spawnSync(s.command || "false", args, { input: init, env: { ...process.env, ...s.env }, encoding: "utf8", timeout: 15000 });
    let ok = false; try { ok = Boolean(JSON.parse((r.stdout || "").split("\n")[0]).result); } catch {}
    console.log(name + ": " + (s.command || s.url) + " " + args.join(" ") + " - " + (ok ? "✔ Connected" : "✗ Failed to connect"));
  }
} else process.exit(2);
`;

/** 假 codex：状态存在 $CODEX_HOME/state.json，同时写一份 config.toml 的表头（detect 只看表头） */
const FAKE_CODEX = String.raw`
const fs = require("fs"), path = require("path");
const argv = process.argv.slice(2), dir = process.env.CODEX_HOME, state = path.join(dir, "state.json");
fs.appendFileSync(path.join(process.env.HOME, "codex-argv.log"), JSON.stringify(argv) + "\n");
const read = () => { try { return JSON.parse(fs.readFileSync(state, "utf8")); } catch { return {}; } };
const write = (d) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(state, JSON.stringify(d));
  fs.writeFileSync(path.join(dir, "config.toml"), Object.keys(d).map((n) => "[mcp_servers." + n + "]\ncommand = \"" + d[n].command + "\"\n").join("\n")); };
if (argv[0] === "login" && argv[1] === "status") {
  if (process.env.FAKE_CODEX_LOGGED === "0") { console.error("Not logged in"); process.exit(1); }
  console.log("Logged in using ChatGPT");
} else if (argv[0] === "mcp" && argv[1] === "list") {
  console.log(JSON.stringify(Object.entries(read()).map(([name, s]) => ({ name, enabled: true, transport: { type: "stdio", command: s.command, args: s.args, env: s.env } }))));
} else if (argv[0] === "mcp" && argv[1] === "add") {
  const dd = argv.indexOf("--"), head = argv.slice(2, dd), cmd = argv.slice(dd + 1); const env = {}; let name = null;
  for (let i = 0; i < head.length; i++) { if (head[i] === "--env") { const [k, ...v] = head[++i].split("="); env[k] = v.join("="); } else name = head[i]; }
  const d = read(); d[name] = { command: cmd[0], args: cmd.slice(1), env }; write(d);
} else if (argv[0] === "mcp" && argv[1] === "remove") {
  const d = read(); delete d[argv[2]]; write(d);
} else process.exit(2);
`;

export interface Sandbox {
  home: string;
  dataDir: string;
  bin: string;
  env: HostEnv;
  /** 假 AutoCrew 服务的端口；stopServer 之后连不上 */
  port: number;
  stopServer(): Promise<void>;
  argv(cli: "claude" | "codex"): string[][];
  cleanup(): Promise<void>;
}

function writeFake(bin: string, name: string, body: string): void {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o755 });
}

/** 假 /mcp：只认 tokens/ 下的宿主令牌（与真服务同一个 lookupHostToken，所以「最后调用时间」照样记） */
function fakeServer(dataDir: string): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!token || !lookupHostToken(token, dataDir)) { res.writeHead(401).end(); return; }
      const id = (JSON.parse(raw) as { id?: unknown }).id;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

export async function makeSandbox(opts: { claude?: boolean; codex?: boolean; extraEnv?: Record<string, string> } = {}): Promise<Sandbox> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-connect-"));
  const home = path.join(root, "home"), dataDir = path.join(root, "autocrew"), bin = path.join(root, "bin");
  for (const d of [home, dataDir, bin, path.join(home, "Applications")]) fs.mkdirSync(d, { recursive: true });
  if (opts.claude !== false) writeFake(bin, "claude", FAKE_CLAUDE);
  if (opts.codex !== false) writeFake(bin, "codex", FAKE_CODEX);
  const server = await fakeServer(dataDir);
  const port = (server.address() as { port: number }).port;
  const childEnv: NodeJS.ProcessEnv = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, CODEX_HOME: path.join(home, ".codex"), AUTOCREW_LOCAL_DIR: dataDir, ...opts.extraEnv };
  const env: HostEnv = {
    home, dataDir, binDirs: [bin], appDirs: [path.join(home, "Applications")],
    claudeConfig: path.join(home, ".claude.json"), codexHome: path.join(home, ".codex"),
    forwarder: { command: process.execPath, args: [path.join(REPO, "bin", "autocrew.mjs"), "mcp"], env: { AUTOCREW_PORT: String(port), AUTOCREW_LOCAL_DIR: dataDir } },
    childEnv, run: makeRunner(childEnv), runWith: makeRunner,
  };
  let stopped = false;
  const stopServer = () => (stopped ? Promise.resolve() : new Promise<void>((r) => { stopped = true; server.close(() => r()); }));
  const argv = (cli: string) => {
    try { return fs.readFileSync(path.join(home, `${cli}-argv.log`), "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]); } catch { return []; }
  };
  return { home, dataDir, bin, env, port, stopServer, argv, cleanup: async () => { await stopServer(); fs.rmSync(root, { recursive: true, force: true }); } };
}
