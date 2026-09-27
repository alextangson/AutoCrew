import { describe, expect, it } from "vitest";
import type { CoverVersion } from "./cover-board";
import {
  activeTab, APP_CHROME, centerCrop, clampXhsRatio, durationBadge, phonePlaceholders, previewSections, profilePlatformsOf,
  R169, R34, R43, stepTab, surfaceImage, surfaceLayout,
} from "./platform-preview";

const art = (r: string) => ({ path: `05-cover/v001/${r}.png`, sha256: r, role: `cover:${r}`, version: 1, reported_at: "t" });
const version = (pair: CoverVersion["pair"]): CoverVersion => ({ version: 1, at: "t", pair, missing: [] });

describe("previewSections", () => {
  it("固定顺序 抖音→小红书→B站→视频号，与资料里的顺序无关", () => {
    expect(previewSections(["wechat_video", "bilibili", "douyin", "xiaohongshu"]).map((s) => s.label)).toEqual(["抖音", "小红书", "B站", "视频号"]);
  });
  it("只留账号勾选的视频平台，其他平台忽略", () => {
    expect(previewSections(["wechat_mp", "bilibili"]).map((s) => s.id)).toEqual(["bilibili"]);
    expect(previewSections(["wechat_mp"])).toEqual([]);
  });
  it("视频号整块标未核实，其他三家已核实", () => {
    const s = previewSections(["douyin", "xiaohongshu", "bilibili", "wechat_video"]);
    expect(s.map((x) => x.verified)).toEqual([true, true, true, false]);
    expect(s[3].badge).toBe("未核实：按后台代码推断");
  });
  it("抖音三块位置和用哪张封面按调研", () => {
    const [dy] = previewSections(["douyin"]);
    expect(dy.surfaces.map((x) => [x.label, x.cover, x.style])).toEqual([
      ["App 推荐双列卡", "3:4", "feed"], ["App 精选双列卡", "4:3", "feed"], ["个人主页作品网格", "3:4", "grid"],
    ]);
    expect(dy.notes).toContain("网页搜索和精选多显示平台截取的视频帧，不受封面控制");
  });
});

describe("clampXhsRatio", () => {
  it("夹在 3:4 到 4:3 之间", () => {
    expect(clampXhsRatio(9 / 16)).toBe(R34);
    expect(clampXhsRatio(16 / 9)).toBe(R43);
    expect(clampXhsRatio(1)).toBe(1);
    expect(clampXhsRatio(R34)).toBe(R34);
  });
});

describe("centerCrop", () => {
  it("4:3 塞进 16:9 只剩中间 75%，上下各切 12.5%", () => {
    const c = centerCrop(R43, R169);
    expect(c.keptHeight).toBeCloseTo(0.75);
    expect(c.cutEach).toBeCloseTo(0.125);
  });
  it("3:4 塞进 4:3 只剩 56.25%", () => {
    expect(centerCrop(R34, R43).keptHeight).toBeCloseTo(0.5625);
  });
  it("比例一样不裁", () => {
    expect(centerCrop(R43, R43)).toEqual({ keptHeight: 1, cutEach: 0 });
  });
  it("B站网页卡用 4:3 封面裁", () => {
    const web = previewSections(["bilibili"])[0].surfaces.find((s) => s.id === "bili-web")!;
    expect([web.cover, web.ratio, web.crop]).toEqual(["4:3", R169, true]);
  });
});

describe("surfaceImage", () => {
  const [dy] = previewSections(["douyin"]);
  it("有就用对应那张", () => {
    expect(surfaceImage(dy.surfaces[1], version({ "3:4": art("3:4"), "4:3": art("4:3") }))).toEqual({ artifact: art("4:3") });
  });
  it("缺那张不拿另一张顶替", () => {
    expect(surfaceImage(dy.surfaces[1], version({ "3:4": art("3:4") }))).toEqual({ missing: "这一版没有 4:3，平台会用视频截帧或拒绝" });
    expect(surfaceImage(dy.surfaces[0], version({ "4:3": art("4:3") }))).toEqual({ missing: "这一版没有 3:4，平台会用视频截帧或拒绝" });
  });
});

describe("durationBadge / profilePlatformsOf", () => {
  it("时长角标，读不到不显示", () => {
    expect(durationBadge(65_000)).toBe("1:05");
    expect(durationBadge(3_725_000)).toBe("1:02:05");
    expect(durationBadge(null)).toBeNull();
    expect(durationBadge(0)).toBeNull();
  });
  it("两种返回形状都认，失败返回 null", () => {
    expect(profilePlatformsOf({ ok: true, platforms: ["douyin"] })).toEqual(["douyin"]);
    expect(profilePlatformsOf({ ok: true, data: { platforms: ["bilibili", 3] } })).toEqual(["bilibili"]);
    expect(profilePlatformsOf({ ok: true })).toEqual([]);
    expect(profilePlatformsOf({ ok: false, error: "x" })).toBeNull();
  });
});

describe("标签与外壳布局", () => {
  const ids = ["douyin", "bilibili", "wechat_video"] as const;
  it("记住的标签还在就用，不在或没选回到第一个", () => {
    expect(activeTab(ids, "bilibili")).toBe("bilibili");
    expect(activeTab(ids, "xiaohongshu")).toBe("douyin");
    expect(activeTab(ids, null)).toBe("douyin");
    expect(activeTab([], "douyin")).toBeNull();
  });
  it("←/→ 首尾循环", () => {
    expect(stepTab(ids, "douyin", 1)).toBe("bilibili");
    expect(stepTab(ids, "douyin", -1)).toBe("wechat_video");
    expect(stepTab(ids, "wechat_video", 1)).toBe("douyin");
  });
  it("B站网页两处进浏览器，其余进手机", () => {
    const all = previewSections(["douyin", "xiaohongshu", "bilibili", "wechat_video"]);
    const frames = all.flatMap((p) => p.surfaces.map((s) => [s.id, surfaceLayout(p.id, s).frame]));
    expect(frames.filter(([, f]) => f === "browser").map(([id]) => id)).toEqual(["bili-web", "bili-space"]);
  });
  it("灰卡填满一屏：抖音推荐 2 列 3 行、主页网格 3 列带头部、浏览器固定行数", () => {
    const [dy] = previewSections(["douyin"]), [bili] = previewSections(["bilibili"]);
    expect(surfaceLayout("douyin", dy.surfaces[0])).toEqual({ frame: "phone", columns: 2, profile: false, placeholders: 5 });
    const grid = surfaceLayout("douyin", dy.surfaces[2]);
    expect([grid.columns, grid.profile]).toEqual([3, true]);
    expect(grid.placeholders).toBeGreaterThanOrEqual(5);
    expect(surfaceLayout("bilibili", bili.surfaces[1]).placeholders).toBe(7);
  });
  it("扁卡比高卡一屏摆得多；视频号没底栏", () => {
    const o = { profile: false, bottomBar: true, text: true };
    expect(phonePlaceholders(2, R43, o)).toBeGreaterThan(phonePlaceholders(2, R34, o));
    expect(APP_CHROME.wechat_video.tabs).toEqual([]);
    expect(APP_CHROME.douyin.tabs).toEqual(["首页", "朋友", "＋", "消息", "我"]);
  });
});
