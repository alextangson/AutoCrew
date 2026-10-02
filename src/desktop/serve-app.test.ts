/** 前端外壳不缓存、带哈希的资源长缓存（1b 验收：重启后浏览器还拿旧包，按钮文字停在旧版） */
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveApp } from "./serve-app.js";

let dist: string;
let server: http.Server;
let base: string;
beforeAll(async () => {
  dist = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-dist-"));
  await fs.mkdir(path.join(dist, "assets"));
  await fs.writeFile(path.join(dist, "index.html"), "<!doctype html>");
  await fs.writeFile(path.join(dist, "assets", "index-abc123.js"), "x");
  await fs.writeFile(path.join(dist, "favicon.ico"), "i");
  server = http.createServer((req, res) => void serveApp(dist, res, new URL(req.url ?? "/", "http://x").pathname));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); await fs.rm(dist, { recursive: true, force: true }); });

describe("静态托管的缓存头", () => {
  it("/、/index.html、SPA 回退（深链）→ no-cache", async () => {
    for (const p of ["/", "/index.html", "/editor/content-1-a"]) {
      const r = await fetch(base + p);
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-cache");
    }
  });
  it("带哈希的 /assets/* → 长缓存 + immutable；零散文件不长缓存", async () => {
    expect((await fetch(`${base}/assets/index-abc123.js`)).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await fetch(`${base}/favicon.ico`)).headers.get("cache-control")).toBe("no-cache");
  });
});
