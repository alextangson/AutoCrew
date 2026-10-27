/**
 * ChatCut 工程格式 29（2026-10-27：《AI 交来的东西为什么越读越累》的闪帧检查卡在「格式版本（29）不认识」）。
 * 对过本机真实 v29 工程：条目字段与 v25 相同，只在时间线顶层多了 markers（时间线标记，不影响画面）。
 * 复用 v25 夹具，补上 markers 当 v29 时间线。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectSlivers } from "./detect.js";
import { SUPPORTED_SCHEMAS, type Json, type SnapshotAsset } from "./snapshot-types.js";

const raw = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "chatcut-v25-timeline.fixture.json"), "utf8")) as Json & { _assetTypes: Record<string, string> };
const { _assetTypes: types, ...v25 } = raw;
const timeline: Json = { ...v25, markers: [{ id: "marker-1", frame: 120, label: "这里换 B-roll" }] };
const AROLL_ASSET = ((timeline.videoItems as Json[])[0].assetId) as string;
const assets: Record<string, SnapshotAsset> = Object.fromEntries(Object.entries(types).map(([id, type]) => [id, { id, type, path: `/fake/${id}.mp4`, duration: 600_000_000, pix_fmt: "yuv420p" }]));

describe("ChatCut 工程格式 29", () => {
  it("29 在核过的版本里", () => { expect(SUPPORTED_SCHEMAS.has(29)).toBe(true); });

  it("带 markers 的 v29 时间线照常查，结果和同一条 v25 时间线一样", () => {
    const run = (tl: Json, schemaVersion: number) => detectSlivers({
      snap: { schemaVersion, project_id: "proj", timeline_id: "tl", timeline: tl, assets },
      fps: { num: 30, den: 1 }, aroll: { facts: [{ id: "fact-aroll", label: "原片", paths: [`/fake/${AROLL_ASSET}.mp4`] }] }, cutFrames: null,
    });
    const r29 = run(timeline, 29);
    expect(r29.status, r29.reason).not.toBe("unchecked");
    expect(r29).toEqual(run(v25, 25));
  });
});
