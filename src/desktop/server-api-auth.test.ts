/**
 * /api/* 只认本地主体（浏览器会话 + server-token）；命名宿主 token 只属于 /mcp。
 *
 * 起真的 desktop/server.ts：漏洞就出在 server.ts 的接线（/api/invoke 只看认证方法、
 * 不看主体），只测 LocalSessionAuth 的纯逻辑证明不了路由没绕过它。
 * HOME 与 dataDir 都指到临时目录，守护进程的后台任务碰不到真资料库。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureHostToken } from "./host-tokens.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let proc: ChildProcess;
let base: string;
let origin: string;
let dir: string;
let codexToken: string;
let localToken: string;
let sessionCookie: string;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForBootToken(logs: () => string): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server exited early:\n${logs()}`);
    const match = logs().match(/\?token=([0-9a-f]+)/);
    if (match) return match[1];
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server not ready:\n${logs()}`);
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "autocrew-api-auth-"));
  const dataDir = path.join(dir, "data");
  codexToken = readFileSync(ensureHostToken("codex", dataDir), "utf-8").trim();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  origin = base;
  // AUTOCREW_LOCAL_DIR 优先于 AUTOCREW_DATA_DIR（storage-roots）——不覆盖它，继承来的值会让测试碰真资料库
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(dir, "home"), AUTOCREW_LOCAL_DIR: dataDir, AUTOCREW_DATA_DIR: dataDir, AUTOCREW_PORT: String(port) };
  delete env.AUTOCREW_TOKEN;
  let out = "";
  proc = spawn(process.execPath, ["--import", "tsx", "desktop/server.ts"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  proc.stdout!.on("data", (c) => { out += c; });
  proc.stderr!.on("data", (c) => { out += c; });
  const boot = await waitForBootToken(() => out);
  localToken = readFileSync(path.join(dataDir, "server-token"), "utf-8").trim();
  const res = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: boot }),
  });
  sessionCookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  // cookie 名带端口（1b §9）：预览服务不顶掉正式服务的登录
  expect(sessionCookie).toMatch(new RegExp(`^autocrew_session_${port}=`));
  bootToken = boot;
}, 40_000);

let bootToken: string;

describe("登录跨重启（1b §9）", () => {
  const exchange = (headers: Record<string, string>) => fetch(`${base}/api/session`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify({ token: bootToken }),
  });
  it("地址栏残留已用过的 token + 有效 cookie → 200 existing，不另发会话；顺手清掉旧名 cookie", async () => {
    const res = await exchange({ Cookie: `autocrew_session=old; ${sessionCookie}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, existing: true });
    expect(res.headers.get("set-cookie")).toBe("autocrew_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  });
  it("token 与 cookie 都无效 → 403；只有旧名 cookie 也不认", async () => {
    expect((await exchange({})).status).toBe(403);
    expect((await exchange({ Cookie: sessionCookie.replace(/^autocrew_session_\d+=/, "autocrew_session=") })).status).toBe(403);
  });
});

afterAll(() => {
  if (proc?.pid && proc.exitCode === null) {
    try { process.kill(-proc.pid, "SIGKILL"); } catch { /* 已退 */ }
  }
  rmSync(dir, { recursive: true, force: true });
});

const invoke = (headers: Record<string, string>) =>
  fetch(`${base}/api/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ channel: "hosts:list", payload: {} }),
  });

const upload = (headers: Record<string, string>) =>
  fetch(`${base}/api/upload?name=probe.txt`, { method: "POST", headers, body: "x" });

const mcp = (token: string, method: string, params: Record<string, unknown>) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

async function listedTools(token: string): Promise<string[]> {
  const res = await mcp(token, "tools/list", {});
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
}

describe("/api/* rejects named host tokens", () => {
  it("returns 403 for the codex token on /api/invoke, /api/upload and /api/events", async () => {
    const bearer = { Authorization: `Bearer ${codexToken}` };
    const inv = await invoke(bearer);
    expect(inv.status).toBe(403);
    expect(await inv.json()).toMatchObject({ ok: false, error: "host token is only valid on /mcp" });
    expect((await upload(bearer)).status).toBe(403);
    expect((await fetch(`${base}/api/events`, { headers: bearer })).status).toBe(403);
  });

  it("still lets the automation token and the browser session through", async () => {
    const byToken = await invoke({ Authorization: `Bearer ${localToken}` });
    expect(byToken.status).toBe(200);
    expect(await byToken.json()).toMatchObject({ ok: true });
    const bySession = await invoke({ Origin: origin, Cookie: sessionCookie });
    expect(bySession.status).toBe(200);
    expect((await upload({ Authorization: `Bearer ${localToken}` })).status).toBe(200);
    expect((await upload({ Origin: origin, Cookie: sessionCookie })).status).toBe(200);
  });

  it("leaves /mcp open to the codex token, still under its host policy", async () => {
    const codexTools = await listedTools(codexToken);
    // 2026-10-02 起 codex 与别的命名宿主能力一样：写稿工具也列；采纳仍拒
    expect(codexTools).toContain("autocrew_status");
    expect(codexTools).toContain("autocrew_writer");
    const denied = await mcp(codexToken, "tools/call", { name: "autocrew_content", arguments: { action: "adoption", content_id: "content-1-abc" } });
    expect(denied.status).toBe(200);
    expect(((await denied.json()) as { result: { isError?: boolean } }).result.isError).toBe(true);
  });
});

/**
 * 仓库 .mcp.json（也是 Claude Code 插件的 MCP 配置）带 AUTOCREW_HOST=claude-code（2026-10-02 创始人定）：
 * 用 claude-code 的令牌、身份就是 claude-code；还没接上时说清怎么接，绝不回落到 server-token 当 local-user。
 */
describe("repo .mcp.json entry identifies as claude-code", () => {
  const entry = JSON.parse(readFileSync(path.join(REPO_ROOT, ".mcp.json"), "utf-8")).mcpServers.autocrew as { command: string; args: string[]; env?: Record<string, string> };
  function runEntry(messages: unknown[]): Promise<Array<Record<string, any>>> {
    const args = entry.args.map((a) => a.replace("${CLAUDE_PLUGIN_ROOT:-.}", REPO_ROOT));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: path.join(dir, "home"), AUTOCREW_LOCAL_DIR: path.join(dir, "data"), AUTOCREW_PORT: new URL(base).port, ...entry.env };
    return new Promise((resolve) => {
      const child = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      child.stdout!.on("data", (c) => { out += c; });
      child.on("close", () => resolve(out.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
      child.stdin!.end(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
    });
  }

  it("the entry names the claude-code host", () => {
    expect(entry.env).toEqual({ AUTOCREW_HOST: "claude-code" });
  });

  it("no claude-code token yet: a plain message on initialize says how to connect, no server-token fallback", async () => {
    const [reply] = await runEntry([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }]);
    expect(reply.error.message).toContain("autocrew connect claude-code");
    expect(reply.error.message).toContain("一键接上");
  });

  it("with the claude-code token: works as claude-code — adoption refused, hidden tools hidden", async () => {
    ensureHostToken("claude-code", path.join(dir, "data"));
    const [list, adopt] = await runEntry([
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "autocrew_content", arguments: { action: "adoption", content_id: "content-1-abc" } } },
    ].map((m) => m)).then((r) => [r.find((x) => x.id === 1)!, r.find((x) => x.id === 2)!]);
    const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("autocrew_writer");
    expect(names).not.toContain("autocrew_generate");
    expect(adopt.result.isError).toBe(true);
    expect(JSON.stringify(adopt.result)).toContain("宿主不能代填");
  });
});
