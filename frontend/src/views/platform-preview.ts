/**
 * 封面「在平台上看看」的纯逻辑：四个平台各有哪些位置、用哪张封面、按什么比例裁、叠什么元素。
 * 全部照 docs/research/2026-09-27-platform-cover-surfaces.md「给预览窗口的规格」，不编像素、安全区、字数上限。
 */
import type { CoverRatio, CoverVersion } from "./cover-board";
import type { Artifact } from "./project-board";

export type PlatformId = "douyin" | "xiaohongshu" | "bilibili" | "wechat_video";
/** 卡片样式：feed=图下两行标题+头像昵称+点赞；grid=图上底部渐变+播放数；bili-web=16:9 裁切卡；row=列表小缩略图 */
export type SurfaceStyle = "feed" | "grid" | "bili-web" | "row";
export type Surface = {
  id: string; label: string; cover: CoverRatio; /** 显示框宽高比（宽/高） */ ratio: number; style: SurfaceStyle;
  /** 右上角播放图标（小红书） */ playTopRight?: boolean; /** 图上左下播放数、弹幕数（B站 App 官方预览） */ playStats?: boolean; /** 显示框比封面扁时，从封面居中裁 */ crop?: boolean;
};
export type PlatformSection = { id: PlatformId; label: string; verified: boolean; badge?: string; notes: string[]; surfaces: Surface[] };

export const R34 = 3 / 4, R43 = 4 / 3, R169 = 16 / 9;
export const PLATFORM_ORDER: readonly PlatformId[] = ["douyin", "xiaohongshu", "bilibili", "wechat_video"];
export const NUMBERS_NOTE = "数字是示意；卡片样式按各平台官方封面预览和网页实测，字号与像素规格未核实";

/** 小红书只收一张封面，卡片显示比例 = 封面比例夹在 3:4 到 4:3 之间 */
export function clampXhsRatio(coverRatio: number): number {
  return Math.min(R43, Math.max(R34, coverRatio));
}
export const ratioValue = (r: CoverRatio) => (r === "3:4" ? R34 : R43);

const SECTIONS: Record<PlatformId, PlatformSection> = {
  douyin: { id: "douyin", label: "抖音", verified: true, notes: ["网页搜索和精选多显示平台截取的视频帧，不受封面控制"], surfaces: [
    { id: "dy-recommend", label: "App 推荐双列卡", cover: "3:4", ratio: R34, style: "feed" },
    { id: "dy-featured", label: "App 精选双列卡", cover: "4:3", ratio: R43, style: "feed" },
    { id: "dy-profile", label: "个人主页作品网格", cover: "3:4", ratio: R34, style: "grid" },
  ] },
  xiaohongshu: { id: "xiaohongshu", label: "小红书", verified: true, notes: ["小红书只收一张封面，这里默认用 3:4；卡片比例会夹在 3:4 到 4:3 之间"], surfaces: [
    { id: "xhs-explore", label: "发现 / 搜索双列卡", cover: "3:4", ratio: clampXhsRatio(R34), style: "feed", playTopRight: true },
    { id: "xhs-profile", label: "个人主页网格", cover: "3:4", ratio: clampXhsRatio(R34), style: "feed", playTopRight: true },
  ] },
  bilibili: { id: "bilibili", label: "B站", verified: true, notes: ["网页端显示 16:9，这里从 4:3 封面居中裁，斜线条是会被裁掉的部分"], surfaces: [
    { id: "bili-app", label: "App 首页推荐双列卡", cover: "4:3", ratio: R43, style: "feed", playStats: true },
    { id: "bili-web", label: "网页首页 / 搜索卡", cover: "4:3", ratio: R169, style: "bili-web", crop: true },
    { id: "bili-space", label: "个人空间列表", cover: "4:3", ratio: R169, style: "row", crop: true },
  ] },
  wechat_video: { id: "wechat_video", label: "视频号", verified: false, badge: "未核实：按后台代码推断",
    notes: ["竖屏视频两处都用 3:4"], surfaces: [
      { id: "wx-profile", label: "个人主页卡片", cover: "3:4", ratio: R34, style: "feed" },
      { id: "wx-share", label: "朋友圈 / 聊天分享卡片（横屏视频）", cover: "4:3", ratio: R43, style: "feed" },
    ] },
};

/** 按固定顺序只留账号在做的视频平台（资料里的 id） */
export function previewSections(profilePlatforms: readonly string[]): PlatformSection[] {
  const on = new Set(profilePlatforms);
  return PLATFORM_ORDER.filter((id) => on.has(id)).map((id) => SECTIONS[id]);
}

/** 封面（宽高比 src）居中塞进显示框（宽高比 box）后留下的高度比例和上下各切掉的比例；框更高时不裁高度 */
export function centerCrop(src: number, box: number): { keptHeight: number; cutEach: number } {
  const keptHeight = box > src ? src / box : 1;
  return { keptHeight, cutEach: (1 - keptHeight) / 2 };
}

export type SurfaceImage = { artifact: Artifact } | { missing: string };
/** 位置要的那张这一版没有：不拿另一张顶替 */
export function surfaceImage(surface: Surface, v: CoverVersion): SurfaceImage {
  const a = v.pair[surface.cover];
  return a ? { artifact: a } : { missing: `这一版没有 ${surface.cover}，平台会用视频截帧或拒绝` };
}

/** 成片时长 → 平台角标样式 m:ss / h:mm:ss；读不到返回 null（不显示） */
export function durationBadge(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
  const t = Math.round(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** onboarding:status 两种返回形状里的 platforms */
export function profilePlatformsOf(res: unknown): string[] | null {
  const r = res as { ok?: boolean; platforms?: unknown; data?: { platforms?: unknown } } | null;
  if (!r || r.ok === false) return null;
  const p = r.platforms ?? r.data?.platforms;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
}

// ---- 布局：平台小标签 + 手机/浏览器外壳（外壳和灰卡是示意，只有封面卡按规格） ----
export const SHELL_NOTE = "手机外壳和旁边的灰卡是示意，只有你的封面卡按平台规格";

/** 记住的标签还在就用它，否则回到第一个 */
export function activeTab(ids: readonly PlatformId[], chosen: PlatformId | null): PlatformId | null {
  return chosen && ids.includes(chosen) ? chosen : ids[0] ?? null;
}
/** ←/→ 切标签，首尾循环 */
export function stepTab(ids: readonly PlatformId[], current: PlatformId, dir: 1 | -1): PlatformId {
  const i = ids.indexOf(current), n = ids.length;
  return n === 0 ? current : ids[((i < 0 ? 0 : i + dir) % n + n) % n];
}

export type AppChrome = { title: string; tabs: string[] };
/** 顶栏纯文字 + 底栏通用标签；视频号在微信里，没有底栏 */
export const APP_CHROME: Record<PlatformId, AppChrome> = {
  douyin: { title: "抖音", tabs: ["首页", "朋友", "＋", "消息", "我"] },
  xiaohongshu: { title: "小红书", tabs: ["首页", "＋", "消息", "我"] },
  bilibili: { title: "B站", tabs: ["首页", "动态", "＋", "会员购", "我的"] },
  wechat_video: { title: "视频号", tabs: [] },
};

export type SurfaceLayout = { frame: "phone" | "browser"; columns: number; profile: boolean; placeholders: number };
type LayoutSpec = { frame: "phone" | "browser"; columns: number; profile?: boolean; rows?: number };
const LAYOUT: Record<string, LayoutSpec> = {
  "dy-recommend": { frame: "phone", columns: 2 }, "dy-featured": { frame: "phone", columns: 2 },
  "dy-profile": { frame: "phone", columns: 3, profile: true },
  "xhs-explore": { frame: "phone", columns: 2 }, "xhs-profile": { frame: "phone", columns: 2, profile: true },
  "bili-app": { frame: "phone", columns: 2 },
  "bili-web": { frame: "browser", columns: 3, rows: 2 }, "bili-space": { frame: "browser", columns: 1, rows: 4 },
  "wx-profile": { frame: "phone", columns: 2, profile: true }, "wx-share": { frame: "phone", columns: 1 },
};

/** 手机屏的设计尺寸（19.5:9）和各条高度，只用来算一屏摆几张灰卡 */
export const PHONE = { w: 280, h: (280 * 19.5) / 9, status: 28, top: 40, bottom: 48, profile: 96, pad: 8, gap: 8, text: 44 };

/** 一屏能露出几行（最后一行露一部分也算），减去我们那张就是灰卡数 */
export function phonePlaceholders(columns: number, ratio: number, opts: { profile: boolean; bottomBar: boolean; text: boolean }): number {
  const P = PHONE, cellW = (P.w - 2 * P.pad - (columns - 1) * P.gap) / columns;
  const cellH = cellW / ratio + (opts.text ? P.text : 0);
  const area = P.h - P.status - P.top - P.pad - (opts.bottomBar ? P.bottom : 0) - (opts.profile ? P.profile : 0);
  return columns * Math.ceil((area + P.gap) / (cellH + P.gap)) - 1;
}

export function surfaceLayout(platform: PlatformId, s: Surface): SurfaceLayout {
  const spec = LAYOUT[s.id] ?? { frame: "phone", columns: 2 }, profile = spec.profile ?? false;
  const placeholders = spec.frame === "browser" ? spec.columns * (spec.rows ?? 2) - 1
    : phonePlaceholders(spec.columns, s.ratio, { profile, bottomBar: APP_CHROME[platform].tabs.length > 0, text: s.style !== "grid" });
  return { frame: spec.frame, columns: spec.columns, profile, placeholders };
}
