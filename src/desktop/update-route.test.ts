/** 更新端点：只认同源浏览器会话；bearer（命令行自动化 / MCP 宿主）一律 403。 */
import { afterEach, beforeEach, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUpdateHandler } from "./update-route.js";
import type { GitRunner } from "../modules/update/git.js";

let dir: string, server: http.Server, base: string, spawned: number;
const failingGit: GitRunner = async () => ({ ok: false, stdout: "", stderr: "not a git repository" });

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-update-route-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "0.4.0" }));
  spawned = 0;
  const route = createUpdateHandler({
    authorize: (req) => (req.headers.cookie === "s" ? "session" : req.headers.authorization ? "bearer" : null),
    originAllowed: (req) => req.headers.origin === base,
    readBody: async (req) => { let b = ""; for await (const c of req) b += c; return b; },
    root: dir, machineDir: dir, port: 1, git: failingGit,
    spawnUpdater: () => { spawned++; return { ok: true, log: "x" }; },
  });
  server = http.createServer((req, res) => void route(req, res, new URL(req.url!, base)).then((h) => { if (!h) res.writeHead(404).end(); }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
});
afterEach(async () => { await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

it("触发更新：bearer 与跨站一律 403；同源会话才进预检", async () => {
  const post = (headers: Record<string, string>) => fetch(`${base}/api/update/start`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
  expect((await post({ authorization: "Bearer server-token" })).status).toBe(403);
  expect((await post({ authorization: "Bearer server-token", origin: base })).status).toBe(403);
  expect((await post({ cookie: "s" })).status).toBe(403);
  expect((await post({ cookie: "s", origin: "https://evil.example" })).status).toBe(403);
  const ok = await post({ cookie: "s", origin: base });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ ok: false, code: "check_failed" });
  expect(spawned).toBe(0);
});

it("读状态只要会话；设置能关自动检查、记住先不更新", async () => {
  expect((await fetch(`${base}/api/update`, { headers: { authorization: "Bearer t" } })).status).toBe(403);
  const r = await (await fetch(`${base}/api/update`, { headers: { cookie: "s" } })).json();
  expect(r.data).toMatchObject({ current: "0.4.0", settings: { autoCheck: true }, banner: null, running: false });
  const s = await (await fetch(`${base}/api/update/settings`, { method: "POST", headers: { cookie: "s", origin: base }, body: JSON.stringify({ auto_check: false, skip_version: "0.5.0" }) })).json();
  expect(s.data.settings).toEqual({ autoCheck: false, skipVersion: "0.5.0" });
});

it("手动检查失败：原因写在状态里", async () => {
  const r = await (await fetch(`${base}/api/update/check`, { method: "POST", headers: { cookie: "s", origin: base } })).json();
  expect(r.data.status.error).toMatch(/README/);
  expect(r.data.banner).toBeNull();
});
