/** autocrew_insights 作品归属动作：MCP 边界的参数归一（中转端点把对象/数组串成字符串）与回执 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeInsights } from "./insights.js";
import { saveContent } from "../storage/local-store.js";
import { lookupPlatformItem } from "../modules/flywheel/platform-items.js";
import { HUMAN_WRITE } from "../storage/first-body-guard.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-insights-works-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe("work_bind / history_create / history_delete", () => {
  it("work 是 JSON 字符串也照收；items 再串一层也照收", async () => {
    const c = await saveContent({ _provenance: HUMAN_WRITE, title: "稿", body: "b", platform: "douyin", status: "published", tags: [] }, dir);
    const bound = await executeInsights({ action: "work_bind", work: JSON.stringify({ content_id: c.id, platform: "xhs", item_id: "6ab916a5000000001303d9ac" }), _dataDir: dir });
    expect(bound).toMatchObject({ ok: true, status: "bound", platform: "xiaohongshu" });
    expect((await lookupPlatformItem("xiaohongshu", "6ab916a5000000001303d9ac", dir))?.via).toBe("manual");
    const created = await executeInsights({ action: "history_create", work: { title: "开源的agent新媒体团队", published_date: "2026-09-29", items: JSON.stringify([{ platform: "wechat_video", item_id: "export/abc" }]) }, _dataDir: dir });
    expect(created).toMatchObject({ ok: true, status: "created" });
    const del = await executeInsights({ action: "history_delete", work: { content_id: (created as { contentId: string }).contentId }, _dataDir: dir });
    expect(del).toMatchObject({ ok: true, removedBindings: ["wechat_video:export/abc"] });
  });

  it("work 缺失或解析不成对象 → 打回，不当成空参数继续", async () => {
    expect(await executeInsights({ action: "work_bind", _dataDir: dir })).toMatchObject({ ok: false, error: expect.stringContaining("work 必须是对象") });
    expect(await executeInsights({ action: "work_bind", work: "[1,2]", _dataDir: dir })).toMatchObject({ ok: false });
  });
});
