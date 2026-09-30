/**
 * 抽帧缝判定（spec 2026-09-30 §4 / §9 / §12）：合成时间线，每条边界的正反例。
 */
import { describe, expect, it } from "vitest";
import { detectSlivers, timecode } from "./detect.js";
import { AROLL, ASSETS, FPS, aroll, broll, fiveGapScene, image, mg, snap, timeline } from "./fixtures.js";
import type { Json, SnapshotAsset } from "./snapshot-types.js";

const run = (tl: Json, o: { assets?: Record<string, SnapshotAsset>; cutFrames?: number | null; fps?: typeof FPS | null; id?: typeof AROLL } = {}) =>
  detectSlivers({ snap: snap(tl, o.assets), fps: o.fps === undefined ? FPS : o.fps, aroll: o.id ?? AROLL, cutFrames: o.cutFrames ?? null });
const spans = (r: ReturnType<typeof run>) => r.slivers.map((s) => [s.start_frame, s.end_frame]);

/** A-roll 0–300；B-roll 30–100 与 100+gap–200 */
const gapScene = (gap: number, extra: { second?: Json; first?: Json } = {}) =>
  timeline({ videoItems: [aroll("ar", 0, 300), broll("b1", 30, 70, extra.first), broll("b2", 100 + gap, 100 - gap, extra.second)] });

describe("调研场景复刻（§11）", () => {
  it("去掉定格：5 处缝（6 帧 1 处、12 帧 4 处），帧区间与前后条目都对", () => {
    const r = run(fiveGapScene(false));
    expect(r.status).toBe("slivers");
    expect(spans(r)).toEqual([[100, 106], [200, 212], [300, 312], [400, 412], [500, 512]]);
    expect(r.slivers[0]).toMatchObject({ frames: 6, prev_item: "b0", next_item: "b1", prev_name: "空镜", start_tc: "00:03:10" });
  });
  it("有定格：0 处", () => {
    expect(run(fiveGapScene(true))).toMatchObject({ status: "clean", slivers: [] });
  });
});

describe("缝的长度（E11、§12-5）", () => {
  it("E11 只闪 1 帧也算", () => { expect(spans(run(gapScene(1)))).toEqual([[100, 101]]); });
  it("29 帧（< 1 秒）算，30 帧（= 1 秒）不算", () => {
    expect(spans(run(gapScene(29)))).toEqual([[100, 129]]);
    expect(run(gapScene(30)).status).toBe("clean");
  });
  it("帧率按有理数判：30000/1001 下 29 帧仍 < 1 秒、30 帧 ≥ 1 秒", () => {
    const ntsc = { num: 30000, den: 1001 };
    expect(run(gapScene(29), { fps: ntsc }).status).toBe("slivers");
    expect(run(gapScene(30), { fps: ntsc }).status).toBe("clean");
    expect(run(gapScene(24), { fps: { num: 24, den: 1 } }).status).toBe("clean");
  });
  it("E23 帧率读不出 → 未检查", () => { expect(run(gapScene(5), { fps: null })).toMatchObject({ status: "unchecked", reason: "读不出成片帧率" }); });
});

describe("盖住的判定（E6–E9、E22）", () => {
  it("E6 隐藏轨上的条目不算：缝消失 / 出现", () => {
    const tl = gapScene(5);
    (tl.tracks as Json[])[1].hidden = true;
    expect(run(tl).status).toBe("clean"); // B-roll 全隐藏 → 没有盖住段，也就没有缝
    const withHiddenHold = timeline({ videoItems: [aroll("ar", 0, 300), broll("b1", 30, 70), broll("b2", 105, 95)], imageItems: [image("h", 100, 5, { trackId: "v2" })] });
    (withHiddenHold.tracks as Json[])[2].hidden = true;
    expect(spans(run(withHiddenHold))).toEqual([[100, 105]]);
  });
  it("E7 淡出期间算露出：前一段淡出 4 帧 + 2 帧空隙 = 6 帧缝", () => {
    expect(spans(run(gapScene(2, { first: { fadeOutDurationFrames: 4 } })))).toEqual([[96, 102]]);
    expect(spans(run(gapScene(0, { second: { fadeInDurationFrames: 3 } })))).toEqual([[100, 103]]);
  });
  it("E8 画中画不算盖住（中间那段 PiP 不补缝）；pixel-effect 不算盖住", () => {
    const pip = timeline({ videoItems: [aroll("ar", 0, 300), broll("b1", 30, 70), broll("b2", 105, 95)], imageItems: [image("pip", 100, 5, { trackId: "v2", width: 640, height: 360, top: 0, cropTop: 0, cropBottom: 0 })],
      pixelEffectItems: [{ id: "fx", type: "pixel-effect", trackId: "v2", startFrame: 100, durationFrames: 5, enabled: true, targetItemId: "ar" }] });
    expect(spans(run(pip))).toEqual([[100, 105]]);
  });
  it("E8 字幕 / 文字条目不算盖住", () => {
    const tl = timeline({ videoItems: [aroll("ar", 0, 300), broll("b1", 30, 70), broll("b2", 105, 95)], textItems: [{ id: "t", type: "text", trackId: "v2", startFrame: 100, durationFrames: 5 }] });
    expect(spans(run(tl))).toEqual([[100, 105]]);
  });
  it("E9 透明背景动效不算盖住：素材默认、条目覆盖都看", () => {
    const scene = (m: Json) => timeline({ videoItems: [aroll("ar", 0, 300), broll("b1", 30, 70), broll("b2", 105, 95)], motionGraphicItems: [m] });
    expect(run(scene(mg("m", 100, 5))).status).toBe("clean");
    expect(spans(run(scene(mg("m", 100, 5, { propertyOverrides: { transparentBackground: true } }))))).toEqual([[100, 105]]);
    const transparentAsset = { ...ASSETS, M: { ...ASSETS.M, properties: [{ key: "transparentBackground", defaultValue: true }] } };
    expect(spans(run(scene(mg("m", 100, 5)), { assets: transparentAsset }))).toEqual([[100, 105]]);
    expect(run(scene(mg("m", 100, 5, { propertyOverrides: { transparentBackground: false } })), { assets: transparentAsset }).status).toBe("clean");
  });
  it("E22 读不到透明设置 / 素材 alpha 读不出 → 不默认不透明：结论悬着就未检查并点名", () => {
    const noProp = { ...ASSETS, M: { ...ASSETS.M, properties: [] } };
    const r = run(timeline({ videoItems: [aroll("ar", 0, 300), broll("b1", 30, 70), broll("b2", 105, 95)], motionGraphicItems: [mg("m", 100, 5)] }), { assets: noProp });
    expect(r.status).toBe("unchecked");
    expect(r.reason).toContain("「动效」读不到动效的透明背景设置");
    const noFmt = { ...ASSETS, I: { ...ASSETS.I, pix_fmt: null } };
    const r2 = run(timeline({ videoItems: [aroll("ar", 0, 300), broll("b1", 30, 70), broll("b2", 105, 95)], imageItems: [image("h", 100, 5)] }), { assets: noFmt });
    expect(r2).toMatchObject({ status: "unchecked" });
    expect(r2.reason).toContain("读不出素材是否带透明通道");
  });
  it("E22 结论不依赖读不准的条目时照常下结论（长段里的未知条目不影响）", () => {
    const noFmt = { ...ASSETS, I: { ...ASSETS.I, pix_fmt: null } };
    expect(run(timeline({ videoItems: [aroll("ar", 0, 300), broll("b1", 30, 70)], imageItems: [image("h", 150, 60)] }), { assets: noFmt }).status).toBe("clean");
  });
  it("E22 素材带 alpha、圆角、半透明、旋转、非正常混合 → 不算盖住（是缝）", () => {
    const hold = (extra: Json, assets = ASSETS) => spans(run(timeline({ videoItems: [aroll("ar", 0, 300), broll("b1", 30, 70), broll("b2", 105, 95)], imageItems: [image("h", 100, 5, extra)] }), { assets }));
    expect(hold({})).toEqual([]);
    expect(hold({}, { ...ASSETS, I: { ...ASSETS.I, pix_fmt: "rgba" } })).toEqual([[100, 105]]);
    expect(hold({ borderRadius: 12 })).toEqual([[100, 105]]);
    expect(hold({ opacity: 0.8 })).toEqual([[100, 105]]);
    expect(hold({ rotation: 3 })).toEqual([[100, 105]]);
    expect(hold({ blendingMode: "multiply" })).toEqual([[100, 105]]);
  });
  it("E22 遮罩 / 不认识的属性 / 挂了特效 → 读不准，结论悬着就未检查", () => {
    const hold = (extra: Json, fx: Json[] = []) => run(timeline({ videoItems: [aroll("ar", 0, 300), broll("b1", 30, 70), broll("b2", 105, 95)], imageItems: [image("h", 100, 5, extra)], pixelEffectItems: fx }));
    expect(hold({ mask: { shape: "circle" } })).toMatchObject({ status: "unchecked" });
    expect(hold({}, [{ id: "fx", trackId: "v1", startFrame: 100, durationFrames: 5, targetItemId: "h", assetId: "builtin:effect-circle-mask" }]).reason).toContain("挂了特效");
  });
});

describe("边界（E10、E19/E26、E24、E25、E5、E17）", () => {
  it("E10 片头第一段 B-roll 之前、片尾最后一段之后的露出不算", () => {
    expect(run(timeline({ videoItems: [aroll("ar", 0, 300), broll("b1", 5, 90), broll("b2", 100, 195)] })).slivers.map((s) => s.start_frame)).toEqual([95]);
  });
  it("E24 没有 A-roll 的黑帧空洞不算缝", () => {
    expect(run(timeline({ videoItems: [aroll("ar", 0, 100), aroll("ar2", 105, 195), broll("b1", 30, 70), broll("b2", 105, 95)] })).status).toBe("clean");
  });
  it("A-roll 多段、跨轨：按素材身份都算", () => {
    const tl = timeline({ videoItems: [aroll("ar", 0, 100), aroll("ar2", 100, 200, { trackId: "v1" }), broll("b1", 30, 70, { trackId: "v2" }), broll("b2", 105, 95, { trackId: "v2" })] });
    expect(spans(run(tl))).toEqual([[100, 105]]);
  });
  it("E19/E26 两段 B-roll 之间的转场按可能露出：<1 秒报成缝并标转场", () => {
    const tl = timeline({ videoItems: [aroll("ar", 0, 300), broll("b1", 30, 70), broll("b2", 100, 100)], pixelTransitionItems: [{ id: "tr", trackId: "v1", durationFrames: 4, incomingItemId: "b2", outgoingItemId: "b1", enabled: true }] });
    const r = run(tl);
    expect(spans(r)).toEqual([[96, 104]]);
    expect(r.slivers[0].transition).toBe(true);
    const onAroll = timeline({ videoItems: [aroll("ar", 0, 150), aroll("ar2", 150, 150), broll("b1", 30, 200)], pixelTransitionItems: [{ id: "tr", trackId: "v0", durationFrames: 4, incomingItemId: "ar2", outgoingItemId: "ar" }] });
    expect(run(onAroll).status).toBe("clean"); // A-roll 轨自己的转场被上面的 B-roll 挡着
  });
  it("E25 分组 / 嵌套条目、同轨重叠、不认识的条目类型 → 未检查", () => {
    expect(run(timeline({ videoItems: [aroll("ar", 0, 300)] }, { timelineItems: [{ id: "g" }] })).reason).toContain("分组");
    expect(run(timeline({ videoItems: [aroll("ar", 0, 300), broll("b1", 30, 70), broll("b2", 90, 50)] })).reason).toContain("重叠");
    expect(run(timeline({ videoItems: [aroll("ar", 0, 300)] }, { lottieItems: [{ id: "x" }] })).reason).toContain("lottieItems");
  });
  it("E17 认不出 A-roll → 未检查；sha / 路径都对不上时按时长唯一兜底", () => {
    expect(run(gapScene(5), { id: { shas: [], paths: ["/elsewhere.mov"], durationsUs: [] } })).toMatchObject({ status: "unchecked", reason: expect.stringContaining("认不出 A-roll") });
    expect(run(gapScene(5), { id: { shas: [], paths: [], durationsUs: [60_005_000] } }).status).toBe("slivers");
    expect(run(gapScene(5), { id: { shas: ["chatcut-own-hash"], paths: [], durationsUs: [] } }).status).toBe("slivers");
    const twins = { ...ASSETS, B: { ...ASSETS.B, duration: 60_000_000 } };
    expect(run(gapScene(5), { id: { shas: [], paths: [], durationsUs: [60_000_000] }, assets: twins }).reason).toContain("时长都和原片一样");
  });
  it("E5 时间线总长与成片帧数差 > 1 帧 → 未检查；差 1 帧内照查", () => {
    expect(run(gapScene(5), { cutFrames: 280 })).toMatchObject({ status: "unchecked", reason: expect.stringContaining("对不上") });
    expect(run(gapScene(5), { cutFrames: 301 }).status).toBe("slivers");
  });
  it("时间码按帧率", () => { expect(timecode(1935, FPS)).toBe("01:04:15"); expect(timecode(29, { num: 30000, den: 1001 })).toBe("00:00:29"); });
});
