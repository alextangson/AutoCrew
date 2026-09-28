/**
 * 数据页封面端点（数据页规格 §I.56）：起一台真 server 打它——没会话 / 跨源写不进、
 * 类型和大小在服务端挡住、存下来能读回、文件名白名单挡住越界、移除后读不到。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoverHandler } from "./data-cover-route.js";
import { MAX_COVER_BYTES, coverDir, findCover, saveAutoCover, sniffImage } from "../modules/flywheel/data-covers.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const WEBP = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), 1]);
const GIF = new Uint8Array([...Buffer.from("GIF89a"), 1, 2]);

let dir: string, server: http.Server, base: string;
let auth: "session" | "bearer" | null, origin: boolean;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-cover-test-"));
  auth = "session"; origin = true;
  const handle = createCoverHandler({
    authorize: () => auth, originAllowed: () => origin, resolveDataDir: async () => dir,
    readBody: (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); }),
  });
  server = http.createServer((req, res) => {
    void handle(req, res, new URL(req.url ?? "/", "http://127.0.0.1")).then((taken) => { if (!taken) res.writeHead(404).end(); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fs.rm(dir, { recursive: true, force: true });
});

const upload = (key: string, body: Uint8Array) =>
  fetch(`${base}/api/data/cover?key=${encodeURIComponent(key)}`, { method: "POST", body });

describe("sniffImage", () => {
  it("认文件头，不认扩展名", () => {
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(JPG)).toBe("jpg");
    expect(sniffImage(WEBP)).toBe("webp");
    expect(sniffImage(GIF)).toBeNull();
  });
});

describe("/api/data/cover", () => {
  it("存下、读回、替换、移除", async () => {
    const r = await upload("w:douyin#1", PNG);
    const body = await r.json() as { ok: boolean; data: { file: string } };
    expect(body.ok).toBe(true);
    const got = await fetch(`${base}/api/data/cover-file?name=${body.data.file}`);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    await upload("w:douyin#1", JPG); // 换格式：旧文件不留
    expect((await fs.readdir(coverDir(dir))).filter((n) => !n.startsWith("."))).toHaveLength(1);
    const rm = await fetch(`${base}/api/data/cover-remove`, { method: "POST", body: JSON.stringify({ key: "w:douyin#1" }) });
    expect(await rm.json()).toEqual({ ok: true, data: { removed: true } });
    expect(await findCover(dir, "manual", "w:douyin#1")).toBeNull();
  });

  it("不是 png/jpg/webp 或超过 10MB → 一句错误，不落盘", async () => {
    const bad = await upload("c:content-1-a", GIF);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("png / jpg / webp");
    const big = new Uint8Array(MAX_COVER_BYTES + 1); big.set(PNG);
    const tooBig = await upload("c:content-1-a", big);
    expect(tooBig.status).toBe(413);
    await expect(fs.readdir(coverDir(dir))).rejects.toThrow();
  });

  it("没会话 / 跨源不许写；读图也要鉴权；文件名白名单挡路径", async () => {
    auth = "bearer";
    expect((await upload("w:x", PNG)).status).toBe(403);
    auth = "session"; origin = false;
    expect((await upload("w:x", PNG)).status).toBe(403);
    auth = null;
    expect((await fetch(`${base}/api/data/cover-file?name=manual-000000000000000000000000.png`)).status).toBe(403);
    auth = "session"; origin = true;
    expect((await fetch(`${base}/api/data/cover-file?name=..%2F..%2Fetc%2Fpasswd`)).status).toBe(400);
    expect((await upload("bogus", PNG)).status).toBe(400);
  });
});

describe("saveAutoCover", () => {
  const ok = (bytes: Uint8Array) => async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer });

  it("手动补过的不下、已抓过的不重下", async () => {
    await fs.mkdir(coverDir(dir), { recursive: true });
    let calls = 0;
    const counting = async () => { calls += 1; return ok(PNG)(); };
    expect(await saveAutoCover(dir, "douyin#1", "https://x/1.png", counting)).toBe("saved");
    expect(await saveAutoCover(dir, "douyin#1", "https://x/1.png", counting)).toBe("skipped");
    const { saveManualCover } = await import("../modules/flywheel/data-covers.js");
    await saveManualCover(dir, "douyin#2", JPG);
    expect(await saveAutoCover(dir, "douyin#2", "https://x/2.png", counting)).toBe("skipped");
    expect(calls).toBe(1);
  });

  it("下载失败 / 不是图片 → 抛错给调用方记状态", async () => {
    await expect(saveAutoCover(dir, "k", "https://x", async () => ({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) }))).rejects.toThrow("http_403");
    await expect(saveAutoCover(dir, "k", "https://x", ok(GIF))).rejects.toThrow("not_image");
    await expect(saveAutoCover(dir, "k", "http://x", ok(PNG))).rejects.toThrow("not_https");
  });
});
