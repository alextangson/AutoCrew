/**
 * 抽帧检查测试用的合成时间线（仓库公开：不含真实路径、标题、ChatCut id）。
 * 画布 1920×1080、30fps；轨道 v0（A-roll，order 0）、v1（B-roll，order 1）、v2（order 2）。
 */
import type { Json, Snapshot, SnapshotAsset } from "./snapshot-types.js";

export const FPS = { num: 30, den: 1 };
export const AROLL_PATH = "/fake/aroll.mov";
export const AROLL = { shas: ["sha-aroll"], paths: [AROLL_PATH], durationsUs: [] as number[] };

type Item = Json & { id: string; startFrame: number; durationFrames: number };

export function aroll(id: string, start: number, dur: number, extra: Json = {}): Item {
  return { id, type: "video", trackId: "v0", assetId: "A", startFrame: start, durationFrames: dur, left: 0, top: -1315, width: 2106, height: 3744, borderRadius: 0, sourceIn: 0,
    fadeInDurationFrames: 0, fadeOutDurationFrames: 0, keepAspectRatio: true, ...extra };
}
export function broll(id: string, start: number, dur: number, extra: Json = {}): Item {
  return { id, type: "video", trackId: "v1", assetId: "B", startFrame: start, durationFrames: dur, left: 0, top: 0, width: 1920, height: 1080, borderRadius: 0, sourceIn: 0,
    fadeInDurationFrames: 0, fadeOutDurationFrames: 0, keepAspectRatio: true, ...extra };
}
export function image(id: string, start: number, dur: number, extra: Json = {}): Item {
  return { id, type: "image", trackId: "v1", assetId: "I", startFrame: start, durationFrames: dur, left: 0, top: -8.571428571428555, width: 1920, height: 1097.142857142857,
    cropTop: 0.0078125, cropBottom: 0.0078125, borderRadius: 0, fadeInDurationFrames: 0, fadeOutDurationFrames: 0, keepAspectRatio: true, ...extra };
}
export function mg(id: string, start: number, dur: number, extra: Json = {}): Item {
  return { id, type: "motion-graphic", trackId: "v1", assetId: "M", startFrame: start, durationFrames: dur, left: 0, top: 0, width: 1920, height: 1080,
    fadeInDurationFrames: 0, fadeOutDurationFrames: 0, keepAspectRatio: true, attributeOverrides: null, propertyOverrides: null, ...extra };
}

export const ASSETS: Record<string, SnapshotAsset> = {
  A: { id: "A", type: "video", name: "原片", path: AROLL_PATH, contentSha256: "chatcut-own-hash", duration: 60_000_000, pix_fmt: "yuv420p" },
  B: { id: "B", type: "video", name: "空镜", path: "/fake/b.mp4", duration: 9_000_000, pix_fmt: "yuv420p" },
  I: { id: "I", type: "image", name: "定格", path: "/fake/hold.png", pix_fmt: "rgb24" },
  M: { id: "M", type: "motion-graphic", name: "动效", properties: [{ key: "font", defaultValue: "x" }, { key: "transparentBackground", defaultValue: false, type: "boolean" }] },
};

export function timeline(groups: { videoItems?: Item[]; imageItems?: Item[]; motionGraphicItems?: Item[]; pixelTransitionItems?: Json[]; pixelEffectItems?: Json[] }, extra: Json = {}): Json {
  return {
    id: "tl-1", compositionWidth: 1920, compositionHeight: 1080, durationFrames: 0,
    tracks: [{ id: "v0", order: 0, type: "video", hidden: false }, { id: "v1", order: 1, type: "video", hidden: false }, { id: "v2", order: 2, type: "video", hidden: false }, { id: "a0", order: 3, type: "audio", hidden: false }],
    videoItems: [], imageItems: [], motionGraphicItems: [], gifItems: [], svgItems: [], solidItems: [], textItems: [], audioItems: [], audioTransitionItems: [],
    pixelEffectItems: [], pixelTransitionItems: [], timelineItems: [], captions: {}, markers: [], ...groups, ...extra,
  };
}

export function snap(tl: Json, assets: Record<string, SnapshotAsset> = ASSETS): Snapshot {
  return { schemaVersion: 4, project_id: "proj-1", timeline_id: "tl-1", timeline: tl, assets };
}

/**
 * 复刻调研场景：A-roll 铺满 0–600 帧；五段 B-roll 之间各有 6 / 12 / 12 / 12 / 12 帧的缝；
 * `holds=true` 时每处缝都由定格图片补上（现状 0 处）。
 */
export function fiveGapScene(holds: boolean): Json {
  const gaps: Array<[number, number]> = [[100, 6], [200, 12], [300, 12], [400, 12], [500, 12]];
  const videoItems: Item[] = [aroll("ar", 0, 600)];
  let at = 40;
  gaps.forEach(([gapAt, n], i) => { videoItems.push(broll(`b${i}`, at, gapAt - at)); at = gapAt + n; });
  videoItems.push(broll("b5", at, 560 - at));
  const imageItems = holds ? gaps.map(([gapAt, n], i) => image(`hold${i}`, gapAt, n)) : [];
  return timeline({ videoItems, imageItems });
}
