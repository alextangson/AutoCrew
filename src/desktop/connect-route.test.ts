/** 一键接入端点（O5）：只认同源浏览器会话；bearer / 跨站一律 403。「先不配」持久（O1）；同一宿主不并发。 */
import http from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createConnectHandler } from "./connect-route.js";
import { makeSandbox, type Sandbox } from "./host-connect/test-fakes.js";

let sb: Sandbox, server: http.Server, base: string;

function mount(): Promise<void> {
  const route = createConnectHandler({
    authorize: (req) => (req.headers.cookie === "s" ? "session" : req.headers.authorization ? "bearer" : null),
    originAllowed: (req) => req.headers.origin === base,
    readBody: async (req) => { let b = ""; for await (const c of req) b += c; return b; },
    env: () => sb.env,
  });
  server = http.createServer((req, res) => void route(req, res, new URL(req.url!, base)).then((h) => { if (!h) res.writeHead(404).end(); }));
  return new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`; r(); }));
}

beforeEach(async () => {
  sb = await makeSandbox();
  vi.stubEnv("HOME", sb.home);
  vi.stubEnv("AUTOCREW_LOCAL_DIR", sb.dataDir);
  await mount();
});
afterEach(async () => { vi.unstubAllEnvs(); await new Promise((r) => server.close(r)); await sb.cleanup(); });

const post = (p: string, body: unknown, headers: Record<string, string> = { cookie: "s", origin: base }) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

it("写配置：bearer（含本机 server-token）与跨站一律 403，配置一个字节没写", async () => {
  expect((await post("/api/connect/connect", { host: "claude" }, { authorization: "Bearer server-token", origin: base })).status).toBe(403);
  expect((await post("/api/connect/connect", { host: "claude" }, { cookie: "s" })).status).toBe(403);
  expect((await post("/api/connect/disconnect", { host: "claude" }, { cookie: "s", origin: "https://evil.example" })).status).toBe(403);
  expect((await fetch(`${base}/api/connect`, { headers: { authorization: "Bearer t" } })).status).toBe(403);
  expect(sb.argv("claude")).toEqual([]);
});

it("会话：检测 → 接上 → 列表里显示已接；不认识的宿主 400", async () => {
  const r = await (await post("/api/connect/connect", { host: "claude" })).json();
  expect(r).toMatchObject({ ok: true, verified: true });
  const list = await (await fetch(`${base}/api/connect`, { headers: { cookie: "s" } })).json();
  expect(list.data.hosts.find((h: { host: string }) => h.host === "claude")).toMatchObject({ connected: true });
  expect((await post("/api/connect/connect", { host: "cursor" })).status).toBe(400);
});

it("O1：「先不配」存本机目录，重开服务（新 handler）仍然记得", async () => {
  expect((await (await fetch(`${base}/api/connect`, { headers: { cookie: "s" } })).json()).data.skipped).toBe(false);
  await post("/api/connect/skip", { skipped: true });
  await new Promise((r) => server.close(r));
  await mount();
  expect((await (await fetch(`${base}/api/connect`, { headers: { cookie: "s" } })).json()).data.skipped).toBe(true);
});

it("双击：同一宿主第二下直接回「正在处理」，只注册一次", async () => {
  const [a, b] = await Promise.all([post("/api/connect/connect", { host: "claude" }), post("/api/connect/connect", { host: "claude" })]);
  const replies = [await a.json(), await b.json()];
  expect(replies.filter((x) => x.code === "busy")).toHaveLength(1);
  expect(sb.argv("claude").filter((x) => x[1] === "add")).toHaveLength(1);
});
