/**
 * 整分支审 12：预览核过之后文件被挪 / 删，读流的 error 只断这一个响应，不把服务带倒。
 */
import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";

const gone = path.join(os.homedir(), ".cache", "autocrew-yt", "review-inbox", "not-there", "gone.mp4");
vi.mock("../modules/production/inbox-attachment.js", async (orig) => ({
  ...(await orig<typeof import("../modules/production/inbox-attachment.js")>()),
  openFactMedia: async () => ({ ok: true, file: gone, size: 10, type: "video/mp4" }),
}));

describe("条目预览读流出错", () => {
  it("核过之后文件没了 → 响应被断开，没有未处理的 error", async () => {
    const { createBoardHandler } = await import("./board-route.js");
    const handler = createBoardHandler({ authorize: () => "session", originAllowed: () => true, resolveDataDir: async () => os.tmpdir(), readBody: async () => "" });
    const out = new PassThrough();
    const destroyed = new Promise<void>((resolve) => out.on("close", () => resolve()));
    const res = Object.assign(out, { writeHead: () => res });
    await handler({ method: "GET", headers: {} } as never, res as never, new URL("http://x/api/inbox/media?content_id=content-1-a&fact_id=fact-1"));
    await destroyed;
    expect(out.destroyed).toBe(true);
  });
});
