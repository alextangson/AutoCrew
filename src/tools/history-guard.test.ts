/**
 * 边界：历史作品被误当成生产稿 —— 所有生产 / 审稿 / 剪辑 / 发布入口对 imported_history 一律不受理并说明原因，
 * 看板生产列与待办里也不出现（回流认领规格 2026-10-03）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHistoryRecord } from "../modules/flywheel/work-binding.js";
import { executeWriter } from "./writer.js";
import { executeReviewDesk } from "./host-review.js";
import { executeWorkflow } from "./workflow.js";
import { executeVideo } from "./video.js";
import { executePrePublish, executePrePublishTool } from "./pre-publish.js";
import { executePublish } from "./publish.js";
import { executeCoverReview } from "./cover-review.js";
import { boardData } from "../desktop/board-data.js";
import { markPublished, unmarkPublished } from "../desktop/board-actions.js";
import { buildDashboardSummary } from "../desktop/dashboard-summary.js";
import { buildTodaySummary } from "../desktop/today-summary.js";
import { HISTORY_REFUSAL } from "../storage/imported-history.js";

let dir: string;
let id: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-history-guard-")));
  const r = await createHistoryRecord({ title: "让Agent帮你买东西", published_date: "2026-09-04", items: [{ platform: "douyin", item_id: "7681645549023497523" }] }, dir);
  if (!r.ok) throw new Error(r.error);
  id = r.contentId;
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

const refused = { ok: false, code: "imported_history", error: HISTORY_REFUSAL };

describe("生产 / 审稿 / 发布入口一律不受理 imported_history", () => {
  it("写稿：writer pack / submit", async () => {
    expect(await executeWriter({ action: "pack", content_id: id, _dataDir: dir })).toMatchObject(refused);
    expect(await executeWriter({ action: "submit", content_id: id, title: "t", body: "b", _dataDir: dir })).toMatchObject(refused);
  });

  it("审稿：review_desk pack / submit", async () => {
    expect(await executeReviewDesk({ action: "pack", content_id: id, _dataDir: dir })).toMatchObject(refused);
    expect(await executeReviewDesk({ action: "submit", content_id: id, review_pack_id: "x", attempt: 1, issues: [], _dataDir: dir })).toMatchObject(refused);
  });

  it("工作流：workflow draft", async () => {
    expect(await executeWorkflow({ action: "draft", content_id: id, _dataDir: dir })).toMatchObject(refused);
  });

  it("剪辑：video handoff / status", async () => {
    expect(await executeVideo({ action: "handoff", content_id: id, _dataDir: dir, _host: "codex" })).toMatchObject(refused);
    expect(await executeVideo({ action: "status", content_id: id, _dataDir: dir })).toMatchObject(refused);
  });

  it("发布前：pre_publish check / video_kit，以及 GUI 直调的 executePrePublish", async () => {
    expect(await executePrePublishTool({ action: "check", content_id: id, _dataDir: dir })).toMatchObject(refused);
    expect(await executePrePublishTool({ action: "video_kit", content_id: id, _dataDir: dir })).toMatchObject(refused);
    expect(await executePrePublish({ action: "check", content_id: id, _dataDir: dir, _readOnly: true })).toMatchObject(refused);
  });

  it("发布：publish check / confirm_published / clipboard", async () => {
    for (const action of ["check", "confirm_published", "clipboard"]) {
      expect(await executePublish({ action, content_id: id, platform: "douyin", _dataDir: dir })).toMatchObject(refused);
    }
  });

  it("封面：cover_review", async () => {
    expect(await executeCoverReview({ action: "get", content_id: id, _dataDir: dir })).toMatchObject(refused);
  });
});

describe("看板与待办", () => {
  it("看板不出现历史记录；「我发了」/撤销都不受理", async () => {
    expect((await boardData(dir)).items.some((i) => i.id === id)).toBe(false);
    expect(await markPublished(id, "douyin", "", dir)).toMatchObject({ ok: false, error: HISTORY_REFUSAL });
    expect(await unmarkPublished(id, "douyin", dir)).toMatchObject({ ok: false, error: HISTORY_REFUSAL });
  });

  it("首页回填待办与今日进度不算历史记录", async () => {
    const dash = await buildDashboardSummary(dir, Date.parse("2026-10-03T08:00:00Z"));
    expect(dash.backfillTodos.some((t) => t.id === id)).toBe(false);
    const today = await buildTodaySummary(dir);
    expect(today.pipeline.published).toBe(0);
  });
});
