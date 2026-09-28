// 诊断 Claude 权限：node probe-claude-perm.mjs <variant> <allow|reject>
// variant: flag-ask = _meta.claudeCode.options.settings.permissions.ask；no-user = settingSources 去掉 user
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { homedir } from "node:os";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import * as acp from "@agentclientprotocol/sdk";
const [variant, policy] = process.argv.slice(2);
const cwd = homedir() + "/.cache/autocrew-yt/acp-spike/claude-perm";
mkdirSync(cwd, { recursive: true }); rmSync(cwd + "/deny.txt", { force: true });
const bin = new URL("./node_modules/.bin/claude-agent-acp", import.meta.url).pathname;
const child = spawn(bin, [], { cwd, stdio: ["pipe", "pipe", "ignore"] });
const perms = []; const text = [];
const conn = new acp.ClientSideConnection(() => ({
  requestPermission: async (p) => { perms.push(p.options.map((o) => o.optionId + ":" + o.kind)); const o = p.options.find((x) => x.kind.startsWith(policy)); return { outcome: { outcome: "selected", optionId: o.optionId } }; },
  sessionUpdate: async (n) => { if (n.update.sessionUpdate === "agent_message_chunk") text.push(n.update.content?.text ?? ""); } }),
  acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
const ASK = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"];
const options = variant === "flag-ask" ? { settings: { permissions: { ask: ASK } } }
  : variant === "no-user" ? { settingSources: ["project", "local"] } : {};
const s = await conn.newSession({ cwd, mcpServers: [], _meta: { claudeCode: { options } } });
console.log("modes", s.modes?.currentModeId, JSON.stringify(s.modes?.availableModes?.map((m) => m.id)));
await conn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: "Run this exact shell command with Bash: echo no > deny.txt . If rejected, stop and do not retry any other way. Then tell me: do you see a CLAUDE.md user instruction about replying in Chinese? answer yes/no." }] });
console.log("perms", JSON.stringify(perms), "fileExists", existsSync(cwd + "/deny.txt"), "reply", text.join("").slice(-160).replace(/\n/g, " "));
child.kill("SIGKILL"); process.exit(0);
