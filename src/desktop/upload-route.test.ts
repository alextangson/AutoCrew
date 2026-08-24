// src/desktop/upload-route.test.ts
/**
 * 直传端点的安全面与失败面必须真跑：起一台 127.0.0.1 上的真 server 打它。
 * 断言集中在三件事——没鉴权一个字节都不落盘、文件名再脏也逃不出 uploads/、
 * 传砸了不留半截文件（半截字节 = 素材库里一条打不开的「素材」）。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createUploadHandler, sanitizeUploadName, UPLOAD_PATH } from "./upload-route.js";
import { uploadsDir } from "../storage/library-store.js";

let dir: string;
let server: http.Server;
let port: number;
let authorized: boolean;
let writeAllowed: boolean;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-upload-test-"));
  authorized = true;
  writeAllowed = true;
  const handle = createUploadHandler({
    resolveDataDir: async () => dir,
    authorize: () => authorized,
    writeAllowed: () => writeAllowed,
  });
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    void handle(req, res, pathname).then((taken) => {
      if (!taken) res.writeHead(404).end("no route");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function post(name: string, body: string | Buffer, method = "POST") {
  const res = await fetch(`http://127.0.0.1:${port}${UPLOAD_PATH}?name=${encodeURIComponent(name)}`, {
    method,
    ...(method === "POST" ? { body } : {}),
  });
  const text = await res.text();
  let json: { ok?: boolean; path?: string; size?: number; error?: string } = {};
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    /* 405 之类没有 body */
  }
  return { status: res.status, json };
}

/** uploads/ 下所有文件（含半截 .part）——「清干净了没有」只有这一种问法 */
async function uploadFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  };
  await walk(uploadsDir(dir));
  return out;
}

/** 中断清理发生在 socket 错误之后，轮询等它跑完（超时就让断言自己失败） */
async function waitForEmptyUploads(): Promise<string[]> {
  for (let i = 0; i < 40; i++) {
    const files = await uploadFiles();
    if (files.length === 0) return files;
    await new Promise((r) => setTimeout(r, 50));
  }
  return uploadFiles();
}

describe("sanitizeUploadName", () => {
  it("目录段一律丢弃：穿越写法只剩最后一段", () => {
    expect(sanitizeUploadName("../../../../etc/passwd")).toBe("passwd");
    expect(sanitizeUploadName("/Users/me/Movies/口播.mp4")).toBe("口播.mp4");
    expect(sanitizeUploadName("..\\..\\windows\\system32\\cmd.exe")).toBe("cmd.exe");
  });

  it("控制字符与保留字符去掉，中文与空格留着（名字是人认它的唯一线索）", () => {
    expect(sanitizeUploadName("第一条 口播:终版?.mov")).toBe("第一条 口播终版.mov");
    expect(sanitizeUploadName(String.fromCharCode(97, 0, 98, 31, 99) + ".mp4")).toBe("abc.mp4");
  });

  it("空名与纯点号兜底成 upload，不产出隐藏文件", () => {
    expect(sanitizeUploadName("")).toBe("upload");
    expect(sanitizeUploadName("...")).toBe("upload");
    expect(sanitizeUploadName("/")).toBe("upload");
  });

  it("超长名截断但保留扩展名（类型判定靠它）", () => {
    const long = "长".repeat(300) + ".mp4";
    const safe = sanitizeUploadName(long);
    expect(safe.endsWith(".mp4")).toBe(true);
    expect(safe.length).toBeLessThanOrEqual(84);
  });
});

describe("POST /api/upload", () => {
  it("未认证 → 401，且一个字节都不落盘", async () => {
    authorized = false;
    const res = await post("偷传.mp4", "bytes");
    expect(res.status).toBe(401);
    expect(res.json.ok).toBe(false);
    expect(await uploadFiles()).toEqual([]);
  });

  it("Origin 不对 → 403（写闸与 /api/invoke 同一套）", async () => {
    writeAllowed = false;
    const res = await post("偷传.mp4", "bytes");
    expect(res.status).toBe(403);
    expect(await uploadFiles()).toEqual([]);
  });

  it("非 POST → 405", async () => {
    const res = await post("x.mp4", "", "GET");
    expect(res.status).toBe(405);
  });

  it("正常上传：落进 uploads/、原文件名保留、字节与 size 对得上", async () => {
    const body = Buffer.from("口播的字节".repeat(100), "utf-8");
    const res = await post("我的口播.mp4", body);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.size).toBe(body.byteLength);
    const file = res.json.path!;
    expect(file.startsWith(uploadsDir(dir) + path.sep)).toBe(true);
    expect(path.basename(file)).toBe("我的口播.mp4");
    expect(await fs.readFile(file)).toEqual(body);
    expect(await uploadFiles()).toEqual([file]); // 没有 .part 残留
  });

  it("文件名带穿越：仍然钉死在 uploads/ 内，只留最后一段", async () => {
    const res = await post("../../../../tmp/evil.sh", "x");
    expect(res.status).toBe(200);
    const file = res.json.path!;
    expect(file.startsWith(uploadsDir(dir) + path.sep)).toBe(true);
    expect(path.basename(file)).toBe("evil.sh");
    await expect(fs.access(path.join(os.tmpdir(), "evil.sh"))).rejects.toThrow();
  });

  it("两次同名上传互不覆盖（各占一个时间戳目录）", async () => {
    const a = await post("clip.mp4", "第一条");
    const b = await post("clip.mp4", "第二条");
    expect(a.json.path).not.toBe(b.json.path);
    expect(await fs.readFile(a.json.path!, "utf-8")).toBe("第一条");
    expect(await fs.readFile(b.json.path!, "utf-8")).toBe("第二条");
  });

  it("空文件 → 400 人话错误，盘上不留 0 字节的假素材", async () => {
    const res = await post("空的.mp4", "");
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("0 字节");
    expect(await uploadFiles()).toEqual([]);
  });

  it("客户端中途拔线：半截文件连同目录一起清掉", async () => {
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: `${UPLOAD_PATH}?name=${encodeURIComponent("大片.mp4")}`,
        method: "POST",
        // 声明 1MB 却只发 4KB 就断——服务端读到的是 premature close
        headers: { "content-length": "1048576" },
      });
      req.on("error", () => resolve());
      req.write(Buffer.alloc(4096), () => req.destroy(new Error("拔线")));
    });
    expect(await waitForEmptyUploads()).toEqual([]);
  });

  it("写盘失败（落点不可写）→ 500 人话错误，不抛崩 server", async () => {
    const locked = path.join(dir, "locked");
    await fs.mkdir(locked, { recursive: true });
    await fs.chmod(locked, 0o500); // 只读目录：mkdir uploads 必失败
    const handle = createUploadHandler({
      resolveDataDir: async () => locked,
      authorize: () => true,
      writeAllowed: () => true,
    });
    const failing = http.createServer((req, res) => {
      void handle(req, res, UPLOAD_PATH);
    });
    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
    const failPort = (failing.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${failPort}${UPLOAD_PATH}?name=x.mp4`, { method: "POST", body: "x" });
    const body = (await res.json()) as { ok: boolean; error: string };
    await new Promise<void>((resolve) => failing.close(() => resolve()));
    await fs.chmod(locked, 0o700);
    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("上传中断或写盘失败");
  });
});
