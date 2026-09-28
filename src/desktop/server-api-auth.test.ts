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
  expect(sessionCookie).toMatch(/^autocrew_session=/);
}, 40_000);

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
    expect(codexTools).toContain("autocrew_status");
    expect(codexTools).not.toContain("autocrew_publish");
    expect(await listedTools(localToken)).toContain("autocrew_publish");
    const denied = await mcp(codexToken, "tools/call", { name: "autocrew_publish", arguments: { action: "list" } });
    expect(denied.status).toBe(200);
    expect(((await denied.json()) as { result: { isError?: boolean } }).result.isError).toBe(true);
  });
});
