/**
 * 导入稿快速通道（P6 §13.4-B）：免审稿只在四样同时成立时生效；出处照旧必需。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { acceptanceBlock, type AsIsConfirmation } from "./acceptance.js";
import { draftHash } from "../../../storage/draft-hash.js";
import { getContent, saveContent, type Content } from "../../../storage/local-store.js";
import { initializeProjectLayout } from "../../../storage/content-project.js";
import { callVideo, HAS_FFMPEG, makeFixture, makeMp4, type HandoffFixture } from "./handoff-testkit.js";
import { saveCoverage } from "./project-evidence.js";
import { setPullDeps } from "./pull-deps.js";
import { HUMAN_WRITE } from "../../../storage/first-body-guard.js";

const imported = (extra: Partial<Content> = {}): Content => ({
  id: "content-1", title: "导入稿", body: "正文。", platform: "douyin", status: "draft_ready",
  writingSource: { kind: "manual_import", importedAt: "x", reason: "本地稿导入" }, ...extra,
} as Content);

describe("acceptanceBlock 快速通道", () => {
  const c = imported();
  const ok: AsIsConfirmation = { source: "native-dialog", recorded_as_is: true, draft_hash: draftHash(c), aroll_sha256: "a".repeat(64) };
  it("四样都对才免审稿", () => {
    expect(acceptanceBlock(c, ok, "a".repeat(64))).toBeNull();
    expect(acceptanceBlock(c, { ...ok, source: "founder-workbench" }, "a".repeat(64))).toBeNull();
  });
  it.each([
    ["不是导入稿", imported({ writingSource: undefined }), ok, "a".repeat(64)],
    ["没有 recorded_as_is", c, { ...ok, recorded_as_is: undefined }, "a".repeat(64)],
    ["来源是宿主转述", c, { ...ok, source: "codex-chat" }, "a".repeat(64)],
    ["稿子改过", c, { ...ok, draft_hash: "old" }, "a".repeat(64)],
    ["换了原片", c, ok, "b".repeat(64)],
    ["没有确认记录", c, undefined, "a".repeat(64)],
  ])("%s → not_accepted", (_why, content, confirmation, sha) => {
    expect(acceptanceBlock(content as Content, confirmation as AsIsConfirmation | undefined, sha as string)).toMatchObject({ ok: false, code: "not_accepted" });
  });
});

let fx: HandoffFixture;
beforeEach(async () => {
  fx = await makeFixture();
  await fs.unlink(path.join(fx.dir, "video.json"));
  await initializeProjectLayout(fx.dir, "lib-deadbeef", "default");
  setPullDeps({
    transcriber: { transcribe: async () => ({ ok: false, unavailable: true, reason: "测试不转写" }) },
    dialog: { choose: async (o) => ({ kind: "ok", value: o.items[0] }), ask: async () => ({ kind: "ok", value: "确认" }), input: async () => ({ kind: "timeout" }) },
  });
});
afterEach(async () => { setPullDeps(null); await fx.cleanup(); });

describe.skipIf(!HAS_FFMPEG)("导入稿经弹窗确认后交接", () => {
  it("录音为准：不审文字也能交，但出处照旧必需", async () => {
    const c = await saveContent({ _provenance: HUMAN_WRITE, title: "已经录好的导入稿", body: "我每天省下两小时。第二句。", status: "draft_ready", platform: "douyin", tags: [],
      writingSource: { kind: "manual_import", importedAt: "2026-09-27T00:00:00Z", reason: "本地稿导入" } }, fx.dir);
    const aroll = await makeMp4(path.join(fx.outside, "已经录好的导入稿.mp4"));
    const m = await callVideo(fx.dir, { action: "match", aroll_path: aroll, request_id: "m-1" }, "codex");
    expect(await callVideo(fx.dir, { action: "confirm", receipt_id: m.receipt_id, cover_text: "封面", target_seconds: 60, request_id: "c-0" }, "codex"))
      .toMatchObject({ ok: false, code: "missing_citations" });
    const first = c.body.slice(0, c.body.indexOf("。") + 1);
    await saveCoverage(c, { draft_hash: draftHash(c), citations: [{ start: 0, end: first.length, excerpt: first, evidence_id: "creator", sourceType: "creator_opinion", quote: "", verification: "已录原话、非数据" }], reviewed_by: "writer", reviewed_at: new Date().toISOString() }, fx.dir);
    const cfm = await callVideo(fx.dir, { action: "confirm", receipt_id: m.receipt_id, cover_text: "封面", target_seconds: 60, request_id: "c-1" }, "codex");
    expect(cfm).toMatchObject({ ok: true, recorded_as_is: true });
    const res = await callVideo(fx.dir, { action: "handoff", content_id: c.id, aroll_path: aroll, confirmation_id: cfm.confirmation_id, request_id: "h-1" }, "codex");
    expect(res).toMatchObject({ ok: true, content_status: "editing" });
    expect((await getContent(c.id, fx.dir))!.review).toBeUndefined();
  });
});
