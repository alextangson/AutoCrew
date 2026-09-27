import { beforeEach, afterEach, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProjectReviewHandler } from "./project-review-route.js";
import { initializeProjectLayout, resolveContentProject } from "../storage/content-project.js";
import { saveContent, type Content } from "../storage/local-store.js";
import { draftHash } from "../storage/draft-hash.js";
import { sha256File } from "../modules/video/handoff/manifest.js";

let dir: string, server: http.Server, base: string, content: Content;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-project-http-"));
  await initializeProjectLayout(dir, "lib-deadbeef", "default");
  content = await saveContent({ title: "审核样例", body: "正文", status: "drafting", platform: "douyin", tags: [] }, dir);
  const route = createProjectReviewHandler({
    authorize: req => req.headers.cookie === "fixture-session" ? "session" : req.headers.authorization ? "bearer" : null,
    originAllowed: req => req.headers.origin === base,
    resolveDataDir: async () => dir,
    readBody: async req => { let body = ""; for await (const chunk of req) body += chunk; return body; },
  });
  server = http.createServer((req, res) => { void route(req, res, new URL(req.url!, base)).then(handled => { if (!handled) res.writeHead(404).end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); await fs.rm(dir, { recursive: true, force: true }); });

it("lets the founder read without an Origin header, but never grants a named bearer the approval channel", async () => {
  const url = `${base}/api/project-review?content_id=${content.id}`;
  expect((await fetch(url)).status).toBe(403);
  expect((await fetch(url, { headers: { authorization: "Bearer fixture-editor" } })).status).toBe(403);
  const read = await fetch(url, { headers: { cookie: "fixture-session" } });
  expect(read.status).toBe(200);
  expect((await read.json()).enabled).toBe(true);
  const body = JSON.stringify({ action: "decisions", draft_hash: draftHash(content), title: content.title, cover_text: "封面字", target_seconds: 90 });
  const headers = { "content-type": "application/json", cookie: "fixture-session" };
  expect((await fetch(url, { method: "POST", headers, body })).status).toBe(403);
  expect((await fetch(url, { method: "POST", headers: { ...headers, origin: "https://unrelated.example" }, body })).status).toBe(403);
  const approved = await fetch(url, { method: "POST", headers: { ...headers, origin: base }, body });
  expect(approved.status).toBe(200);
  expect((await approved.json()).decisions.source).toBe("founder-workbench");
});

it("serves only the exact reviewed bytes, supports ranges and rejects escape paths", async () => {
  const root = resolveContentProject(content.id, dir)!.project_root;
  await fs.mkdir(path.join(root, "07-delivery"));
  const file = path.join(root, "07-delivery/final.mp4"); await fs.writeFile(file, "0123456789");
  const url = `${base}/api/project-artifact?content_id=${content.id}&path=07-delivery/final.mp4&sha256=${await sha256File(file)}`;
  const ranged = await fetch(url, { headers: { cookie: "fixture-session", range: "bytes=2-4" } });
  expect(ranged.status).toBe(206); expect(await ranged.text()).toBe("234");
  await fs.writeFile(file, "changed");
  expect((await fetch(url, { headers: { cookie: "fixture-session" } })).status).toBe(409);
  await fs.symlink(dir, path.join(root, "escape"));
  expect((await fetch(`${base}/api/project-artifact?content_id=${content.id}&path=escape/private.mp4`, { headers: { cookie: "fixture-session" } })).status).toBe(403);
});
