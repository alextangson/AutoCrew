/** 「资料放哪」端点：会话+同源或本机 bearer 才能建；当场生效；O15 先问；双击只建一次 */
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLibraryHandler } from "./library-route.js";
import { readLibraryLocation } from "../storage/storage-roots.js";
import { releaseProcessLibraryLocks } from "../storage/library-lock.js";

let home: string, server: http.Server, base: string;
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-libroute-")));
  await fs.mkdir(path.join(home, ".autocrew"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("AUTOCREW_LOCAL_DIR", path.join(home, ".autocrew"));
  vi.stubEnv("AUTOCREW_DATA_DIR", "");
  const route = createLibraryHandler({
    authorize: (req) => (req.headers.cookie === "s" ? "session" : req.headers.authorization === "Bearer ok" ? "bearer" : null),
    originAllowed: (req) => req.headers.origin === base,
    readBody: async (req) => { let b = ""; for await (const c of req) b += c; return b; },
  });
  server = http.createServer((req, res) => void route(req, res, new URL(req.url!, base)).then((h) => { if (!h) res.writeHead(404).end(); }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`; r(); }));
});
afterEach(async () => { releaseProcessLibraryLocks(); vi.unstubAllEnvs(); await new Promise((r) => server.close(r)); await fs.rm(home, { recursive: true, force: true }); });

const post = (p: string, body: unknown, headers: Record<string, string> = { cookie: "s", origin: base }) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

it("no session / cross-site → 403, nothing created", async () => {
  expect((await post("/api/library/setup", { target: path.join(home, "lib") }, {})).status).toBe(403);
  expect((await post("/api/library/setup", { target: path.join(home, "lib") }, { cookie: "s", origin: "https://evil.example" })).status).toBe(403);
  expect(readLibraryLocation()).toBeNull();
});

it("status shows default path; setup creates immediately; bearer (CLI) also works and is idempotent", async () => {
  const st = await (await fetch(`${base}/api/library`, { headers: { cookie: "s" } })).json();
  expect(st.data).toMatchObject({ configured: false, defaultPath: path.join(home, "AutoCrew资料库"), legacyDrafts: 0 });
  const r = await (await post("/api/library/setup", { target: "~/AutoCrew资料库" })).json();
  expect(r).toMatchObject({ ok: true, data: { status: "created" } });
  expect(readLibraryLocation()?.root).toBe(path.join(home, "AutoCrew资料库"));
  const again = await (await post("/api/library/setup", { target: "~/AutoCrew资料库" }, { authorization: "Bearer ok" })).json();
  expect(again.data.status).toBe("already");
});

it("O13 refusal comes back as a visible 400 with the reason", async () => {
  await fs.mkdir(path.join(home, "busy")); await fs.writeFile(path.join(home, "busy", "a.txt"), "x");
  const res = await post("/api/library/setup", { target: path.join(home, "busy") });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ ok: false, code: "not_empty" });
});

it("double click: only one setup runs", async () => {
  const [a, b] = await Promise.all([post("/api/library/setup", { target: "~/AutoCrew资料库" }), post("/api/library/setup", { target: "~/AutoCrew资料库" })]);
  const replies = [await a.json(), await b.json()];
  expect(replies.filter((x) => x.ok && x.data.status === "created")).toHaveLength(1);
});

it("live activation rebinds startup-bound services; parts that still need a restart are reported, not hidden", async () => {
  const calls: string[] = [];
  const route = createLibraryHandler({
    authorize: () => "bearer", originAllowed: () => true,
    readBody: async (req) => { let b = ""; for await (const c of req) b += c; return b; },
    onActivated: async () => { calls.push("rebind"); return ["每日摘要重启导演椅后才用新资料库"]; },
  });
  const s2 = http.createServer((req, res) => void route(req, res, new URL(req.url!, "http://x")).then((h) => { if (!h) res.writeHead(404).end(); }));
  await new Promise<void>((r) => s2.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(s2.address() as import("node:net").AddressInfo).port}`;
  const r = await (await fetch(`${url}/api/library/setup`, { method: "POST", body: JSON.stringify({ target: "~/AutoCrew资料库" }) })).json();
  expect(calls).toEqual(["rebind"]);
  expect(r.data).toMatchObject({ status: "created", afterRestart: ["每日摘要重启导演椅后才用新资料库"] });
  await new Promise((res) => s2.close(res));
});
