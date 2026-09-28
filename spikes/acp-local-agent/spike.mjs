// 阶段 0 spike：逐家验证本机 ACP 适配器是否满足总编辑地基依赖的能力。
// 用法：node spike.mjs <claude|codex|workbuddy> [--auth-fail]
// 暂存目录放 ~/.cache/autocrew-yt/acp-spike（这台 Mac 重启会清 /tmp）。
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const backend = process.argv[2];
const authFail = process.argv.includes("--auth-fail");
const LAUNCH = {
  claude: [join(here, "node_modules/.bin/claude-agent-acp"), []],
  codex: [join(here, "node_modules/.bin/codex-acp"), []],
  workbuddy: ["/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy", ["--acp"]],
};
if (!LAUNCH[backend]) throw new Error("backend?");
const root = join(homedir(), ".cache/autocrew-yt/acp-spike", backend);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const results = {};
const log = (...a) => console.log(`[${backend}]`, ...a);
const TOKEN = "spike-token-123";

// ---- 带鉴权的最小 MCP（streamable http，JSON 应答） ----
const mcpCalls = [];
const mcp = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const auth = req.headers.authorization;
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  if (auth !== `Bearer ${TOKEN}`) { mcpCalls.push({ unauthorized: true }); res.writeHead(401).end(); return; }
  const msg = JSON.parse(body);
  const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })); };
  if (msg.method === "initialize") return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "spike", version: "0" } });
  if (msg.method === "tools/list") return reply({ tools: [{ name: "spike_ping", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
  if (msg.method === "tools/call") { mcpCalls.push({ tool: msg.params.name, args: msg.params.arguments }); return reply({ content: [{ type: "text", text: `pong:${msg.params.arguments?.text}` }] }); }
  if (msg.id === undefined) { res.writeHead(202).end(); return; }
  reply({});
});
await new Promise((r) => mcp.listen(0, "127.0.0.1", r));
const mcpUrl = `http://127.0.0.1:${mcp.address().port}/mcp`;

// ---- ACP client ----
let permissionPolicy = "allow";
const permissionLog = [];
const updates = [];
const agentText = [];
function launch() {
  const [cmd, args] = LAUNCH[backend];
  const env = { ...process.env };
  if (authFail) {
    const empty = join(root, "empty-home");
    mkdirSync(empty, { recursive: true });
    Object.assign(env, { HOME: empty, CLAUDE_CONFIG_DIR: empty, CODEX_HOME: empty });
    delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY;
  }
  const child = spawn(cmd, args, { cwd: root, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const conn = new acp.ClientSideConnection(() => ({
    async requestPermission(p) {
      const kind = permissionPolicy === "allow" ? /allow_once|allow/ : /reject_once|reject|deny/;
      const opt = p.options.find((o) => kind.test(o.kind)) ?? p.options.find((o) => kind.test(o.optionId));
      permissionLog.push({ title: p.toolCall?.title, options: p.options.map((o) => `${o.optionId}:${o.kind}`), chose: opt?.optionId });
      return { outcome: opt ? { outcome: "selected", optionId: opt.optionId } : { outcome: "cancelled" } };
    },
    async sessionUpdate(n) { updates.push(n.update.sessionUpdate); if (n.update.sessionUpdate === "agent_message_chunk" && n.update.content?.type === "text") agentText.push(n.update.content.text); },
    async readTextFile(p) { return { content: readFileSync(p.path, "utf8") }; },
    async writeTextFile() { return {}; },
  }), stream);
  return { child, conn, stderr: () => stderr };
}
const killGroup = (child) => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ } };
async function step(name, fn, ms = 180_000) {
  try {
    const v = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
    results[name] = { pass: v !== false && !v?.fail, detail: typeof v === "object" ? v : undefined };
  } catch (e) { results[name] = { pass: false, error: String(e?.message ?? e).slice(0, 400) }; }
  log(name, JSON.stringify(results[name]));
}

let a = launch();
const initParams = { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } };
let init;
await step("initialize", async () => { init = await a.conn.initialize(initParams); return { agent: init.agentInfo, loadSession: init.agentCapabilities?.loadSession, auth: init.authMethods?.map((m) => m.id), mcpHttp: init.agentCapabilities?.mcpCapabilities?.http }; }, 60_000);
const mcpServers = [{ type: "http", name: "autocrew", url: mcpUrl, headers: [{ name: "Authorization", value: `Bearer ${TOKEN}` }] }];
let sessionId;
await step("session_new", async () => { sessionId = (await a.conn.newSession({ cwd: root, mcpServers })).sessionId; return { sessionId }; }, 60_000);
const prompt = (text) => a.conn.prompt({ sessionId, prompt: [{ type: "text", text }] });
if (authFail) {
  await step("auth_failure_shape", async () => { const r = await prompt("Say hi."); return { stopReason: r.stopReason }; }, 90_000);
  results.stderr_tail = a.stderr().slice(-600);
  finish();
}
await step("mcp_http_auth_call", async () => {
  const r = await prompt("Call the MCP tool spike_ping (server autocrew) with text 'bluebird-42' and tell me its output. Do nothing else.");
  const hit = mcpCalls.find((c) => c.args?.text === "bluebird-42");
  return hit ? { stopReason: r.stopReason, updateKinds: [...new Set(updates)] } : false;
});
await step("permission_allow", async () => {
  permissionPolicy = "allow"; permissionLog.length = 0;
  await prompt("Run this exact shell command with your shell/bash tool: echo ok > allow.txt");
  return existsSync(join(root, "allow.txt")) ? { permissions: [...permissionLog] } : { fail: true, permissions: [...permissionLog] };
});
await step("permission_deny", async () => {
  permissionPolicy = "deny"; permissionLog.length = 0;
  await prompt("Run this exact shell command with your shell/bash tool: echo no > deny.txt . If it is rejected, do not retry any other way; just stop.");
  return !existsSync(join(root, "deny.txt")) && permissionLog.length > 0 ? { permissions: [...permissionLog] } : { fail: true, fileExists: existsSync(join(root, "deny.txt")), permissions: [...permissionLog] };
});
await step("cancel", async () => {
  permissionPolicy = "allow";
  const p = prompt("Run this exact shell command with your shell tool: sleep 60 && echo late > late.txt");
  await new Promise((r) => setTimeout(r, 8000));
  const t0 = Date.now();
  await a.conn.cancel({ sessionId });
  const r = await p;
  return { stopReason: r.stopReason, ms: Date.now() - t0 };
});
await step("session_load_after_kill", async () => {
  killGroup(a.child);
  await new Promise((r) => setTimeout(r, 1000));
  a = launch();
  await a.conn.initialize(initParams);
  const loader = a.conn.loadSession ? "loadSession" : null;
  await a.conn.loadSession({ sessionId, cwd: root, mcpServers });
  agentText.length = 0;
  const r = await prompt("What exact text did I ask you to send to spike_ping earlier in this conversation? Answer with the text only.");
  const answer = agentText.join("");
  void loader;
  return answer.includes("bluebird-42") ? { stopReason: r.stopReason, answer: answer.slice(0, 80) } : { fail: true, answer: answer.slice(0, 200) };
});
finish();

function finish() {
  for (const k of Object.keys(results)) if (results[k]?.detail?.fail) results[k].pass = false;
  results.cancel_file_absent = { pass: !existsSync(join(root, "late.txt")) };
  results.permission_log = permissionLog;
  console.log("RESULT_JSON " + JSON.stringify(results));
  killGroup(a.child);
  mcp.close();
  process.exit(0);
}
