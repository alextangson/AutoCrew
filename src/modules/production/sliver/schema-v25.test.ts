/**
 * ChatCut 工程格式 25（2026-10-26：安克英文版、《4 格内存》的闪帧检查都卡在「格式版本（25）不认识」）。
 * 夹具 chatcut-v25-timeline.fixture.json 取自一份真实 v25 时间线的前 900 帧：id 改写、名字和路径去掉。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectSlivers } from "./detect.js";
import { SUPPORTED_SCHEMAS, type Json, type SnapshotAsset } from "./snapshot-types.js";

const raw = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "chatcut-v25-timeline.fixture.json"), "utf8")) as Json & { _assetTypes: Record<string, string> };
const { _assetTypes: types, ...timeline } = raw;
const AROLL_ASSET = ((timeline.videoItems as Json[])[0].assetId) as string;
const assets: Record<string, SnapshotAsset> = Object.fromEntries(Object.entries(types).map(([id, type]) => [id, { id, type, path: `/fake/${id}.mp4`, duration: 600_000_000, pix_fmt: "yuv420p" }]));
const run = (tl: Json) => detectSlivers({
  snap: { schemaVersion: 25, project_id: "proj-v25", timeline_id: "tl-v25", timeline: tl, assets },
  fps: { num: 30, den: 1 }, aroll: { facts: [{ id: "fact-aroll", label: "原片", paths: [`/fake/${AROLL_ASSET}.mp4`] }] }, cutFrames: null,
});

describe("ChatCut 工程格式 25", () => {
  it("25 在核过的版本里", () => { expect(SUPPORTED_SCHEMAS.has(25)).toBe(true); });

  it("真实 v25 时间线（带 media-link 关联）照常查，不报格式认不出", () => {
    expect((timeline.relations as Json[]).length).toBeGreaterThan(0);
    const r = run(timeline);
    expect(r.status, r.reason).not.toBe("unchecked");
  });

  it("v25 条目上的变速 speed 不算不认识的属性", () => {
    const items = (timeline.videoItems as Json[]).map((it, i) => (i === 1 ? { ...it, speed: { mode: "constant", rate: 1.0241935483870968 } } : it));
    const r = run({ ...timeline, videoItems: items });
    expect(r.status, r.reason).not.toBe("unchecked");
    expect(r.reason ?? "").not.toContain("speed");
  });

  it("不认识的关联（不是 media-link）→ 未检查，点名", () => {
    const r = run({ ...timeline, relations: [{ id: "rel-x", kind: "group", itemIds: [] }] });
    expect(r).toMatchObject({ status: "unchecked", reason: expect.stringContaining("group") });
  });
});
