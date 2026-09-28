import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickUpcoming, rowCover } from "./data-page.js";
import { saveManualCover } from "../modules/flywheel/data-covers.js";
import type { Content } from "../storage/local-store.js";
import type { PlatformPublication, PublishRecord } from "../storage/publish-record.js";
import type { DataRow, Work } from "../modules/flywheel/data-rows.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const pub = (platform: string, state: PlatformPublication["state"], time: string | null): PlatformPublication => ({
  platform, state, submitted: true, raw: null, review: null, time, reason: null, url: null, campaigns: [], manual: null,
});
const content = (id: string) => ({ id, title: `稿 ${id}` }) as Content;
const rec = (...platforms: PlatformPublication[]): PublishRecord => ({ kind: "ok", platforms });

describe("pickUpcoming（§H.49 下一条定时 / 待公开）", () => {
  it("取最早的一条；已公开的不算", () => {
    const up = pickUpcoming([
      { c: content("a"), record: rec(pub("douyin", "public", "2026-09-20T10:00:00Z")) },
      { c: content("b"), record: rec(pub("douyin", "scheduled", "2026-10-05T10:00:00Z")) },
      { c: content("c"), record: rec(pub("douyin", "scheduled", "2026-10-02T10:00:00Z"), pub("bilibili", "reviewing", null)) },
      { c: content("d"), record: null },
    ]);
    expect(up).toEqual({ contentId: "c", title: "稿 c", time: "2026-10-02T10:00:00Z", state: "scheduled", platforms: ["douyin", "bilibili"] });
  });
  it("没有 → null", () => {
    expect(pickUpcoming([{ c: content("a"), record: rec(pub("douyin", "public", null)) }])).toBeNull();
  });
});

describe("rowCover（§I 手动优先）", () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-rowcover-")); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const work = { key: "douyin#1", platform: "douyin" } as Work;
  const row = { id: "w:douyin#1", contentId: null, works: [work] } as unknown as DataRow;

  it("没有封面 → null；自动抓的能用；手动补的盖过自动的；合并后仍按作品认回手动的", async () => {
    expect(await rowCover(row, dir)).toBeNull();
    await fs.mkdir(path.join(dir, "data-covers"), { recursive: true });
    const { saveAutoCover } = await import("../modules/flywheel/data-covers.js");
    await saveAutoCover(dir, "douyin#1", "https://x", async () => ({ ok: true, status: 200, arrayBuffer: async () => PNG.buffer.slice(0) as ArrayBuffer }));
    expect((await rowCover(row, dir))?.kind).toBe("auto");
    await saveManualCover(dir, "w:douyin#1", PNG);
    expect(await rowCover(row, dir)).toMatchObject({ kind: "manual", key: "w:douyin#1" });
    const merged = { ...row, id: "w:bilibili#9", works: [{ key: "bilibili#9" } as Work, work] } as DataRow;
    expect(await rowCover(merged, dir)).toMatchObject({ kind: "manual", key: "w:douyin#1" });
  });
});
