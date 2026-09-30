/**
 * 「盖住」只认验证过的遮盖（spec §4 + §12-4）。一个条目对「是否整屏不透明地盖住 A-roll」只有三种答案：
 * - cover：视频 / 图片 / 动效，裁切后铺满画布，不透明、不旋转、正常混合、无圆角、无遮罩 / 特效、素材无 alpha、动效确认不透明；
 * - none：确定盖不住（画中画、半透明、圆角、有 alpha、透明背景动效、字幕 / 贴纸类条目…）；
 * - unknown：读不到或不认识（未知属性、素材元数据缺、像素格式读不出、动效透明设置读不到）——**绝不默认不透明**。
 */
import type { Json, Snapshot, SnapshotAsset } from "./snapshot-types.js";

export type Cover = { kind: "cover" } | { kind: "none"; why: string } | { kind: "unknown"; why: string };

/** 三类可以盖的条目 */
export const COVER_TYPES: Readonly<Record<string, string>> = { videoItems: "video", imageItems: "image", motionGraphicItems: "motion-graphic" };

/** 已验证对可见性没有影响（或下面逐个判过）的条目属性；出现别的键 → unknown */
const KNOWN_KEYS = new Set([
  "id", "type", "trackId", "assetId", "name", "startFrame", "durationFrames", "fadeInDurationFrames", "fadeOutDurationFrames",
  "left", "top", "width", "height", "keepAspectRatio", "cropTop", "cropBottom", "cropLeft", "cropRight",
  "borderRadius", "opacity", "rotation", "blendingMode", "attributeOverrides", "propertyOverrides",
  // 只影响声音 / 取材位置
  "sourceIn", "decibelAdjustment", "audioFadeInDurationFrames", "audioFadeOutDurationFrames", "playbackRate", "muted", "volume",
]);

/** 已确认不带 alpha 的像素格式（白名单）：只有这些算不透明；不认识的格式当读不准（Codex 审 sliver P2） */
const OPAQUE_FMT = /^(yuvj?4[0-4][0-4]p(9|10|12|14|16)?(le|be)?|nv(12|16|21|24|42)|p0(10|12|16)(le|be)|p2(10|16)(le|be)|p4(10|16)(le|be)|rgb24|bgr24|rgb48(le|be)|bgr48(le|be)|0rgb|rgb0|0bgr|bgr0|gbrp(9|10|12|14|16)?(le|be)?|gray(9|10|12|14|16)?(le|be)?|uyvy422|yuyv422|yvyu422|x2rgb10(le|be)|x2bgr10(le|be))$/;
/** 已知带 alpha（或调色板可能带透明）的像素格式：确定盖不住 */
const ALPHA_FMT = /^(a|ya|yuva|gbrap|rgba|bgra|argb|abgr|pal8|vuya|uyva)/;
const EPS = 0.5;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 裁切后的矩形是否覆盖整个画布（半像素容差） */
function fullCanvas(it: Json, w: number, h: number): boolean | null {
  const [left, top, width, height] = [num(it.left), num(it.top), num(it.width), num(it.height)];
  if (left === null || top === null || width === null || height === null) return null;
  const crop = (k: string) => (it[k] === undefined ? 0 : num(it[k]));
  const [ct, cb, cl, cr] = [crop("cropTop"), crop("cropBottom"), crop("cropLeft"), crop("cropRight")];
  if (ct === null || cb === null || cl === null || cr === null) return null;
  const x0 = left + cl * width, x1 = left + width - cr * width, y0 = top + ct * height, y1 = top + height - cb * height;
  return x0 <= EPS && y0 <= EPS && x1 >= w - EPS && y1 >= h - EPS;
}

/** 条目自己的属性（不看素材） */
function itemProps(it: Json, w: number, h: number): Cover | null {
  const unknownKey = Object.keys(it).find((k) => !KNOWN_KEYS.has(k));
  if (unknownKey) return { kind: "unknown", why: `带有不认识的属性 ${unknownKey}` };
  const full = fullCanvas(it, w, h);
  if (full === null) return { kind: "unknown", why: "位置 / 大小 / 裁切读不出" };
  if (!full) return { kind: "none", why: "没有铺满画面" };
  const opacity = it.opacity === undefined ? 1 : num(it.opacity);
  if (opacity === null) return { kind: "unknown", why: "不透明度读不出" };
  if (opacity < 0.999) return { kind: "none", why: "半透明" };
  const rotation = it.rotation === undefined ? 0 : num(it.rotation);
  if (rotation === null) return { kind: "unknown", why: "旋转读不出" };
  if (rotation !== 0) return { kind: "none", why: "旋转过" };
  if (it.blendingMode !== undefined && it.blendingMode !== "normal") return { kind: "none", why: "混合模式不是正常" };
  const radius = it.borderRadius === undefined ? 0 : num(it.borderRadius);
  if (radius === null) return { kind: "unknown", why: "圆角读不出" };
  if (radius !== 0) return { kind: "none", why: "有圆角" };
  const attrs = it.attributeOverrides;
  if (attrs !== undefined && attrs !== null && !(typeof attrs === "object" && !Array.isArray(attrs) && Object.keys(attrs).length === 0)) {
    return { kind: "unknown", why: "带有不认识的属性覆盖（attributeOverrides）" };
  }
  return null;
}

/** 动效：必须读得到透明背景设置（素材默认 + 条目覆盖）且为不透明 */
function motionGraphic(it: Json, asset: SnapshotAsset): Cover {
  const prop = (asset.properties ?? []).find((p) => p.key === "transparentBackground");
  if (!prop || typeof prop.defaultValue !== "boolean") return { kind: "unknown", why: "读不到动效的透明背景设置" };
  const overrides = it.propertyOverrides;
  let transparent = prop.defaultValue;
  if (overrides !== undefined && overrides !== null) {
    if (typeof overrides !== "object" || Array.isArray(overrides)) return { kind: "unknown", why: "动效的属性覆盖读不出" };
    const o = (overrides as Json).transparentBackground;
    if (o !== undefined) {
      if (typeof o !== "boolean") return { kind: "unknown", why: "动效的透明背景覆盖读不出" };
      transparent = o;
    }
  }
  return transparent ? { kind: "none", why: "动效是透明背景" } : { kind: "cover" };
}

/** 图片 / 视频：素材必须确认没有 alpha 通道 */
function raster(asset: SnapshotAsset): Cover {
  if (asset.pix_fmt === undefined || asset.pix_fmt === null) return { kind: "unknown", why: "读不出素材是否带透明通道" };
  if (ALPHA_FMT.test(asset.pix_fmt)) return { kind: "none", why: `素材带透明通道（${asset.pix_fmt}）` };
  return OPAQUE_FMT.test(asset.pix_fmt) ? { kind: "cover" } : { kind: "unknown", why: `素材像素格式 ${asset.pix_fmt} 不认识，不知道有没有透明通道` };
}

/** `targeted` = 有特效挂在这个条目上（遮罩、马赛克…都走特效，一律当读不准） */
export function classifyCover(group: string, it: Json, snap: Snapshot, targeted: boolean): Cover {
  const type = COVER_TYPES[group];
  if (!type) return { kind: "none", why: "这类条目不算盖住" };
  const tl = snap.timeline;
  const w = num(tl.compositionWidth), h = num(tl.compositionHeight);
  if (w === null || h === null) return { kind: "unknown", why: "画布尺寸读不出" };
  const own = itemProps(it, w, h);
  if (own) return own;
  if (targeted) return { kind: "unknown", why: "上面挂了特效（可能是遮罩 / 局部效果）" };
  const asset = typeof it.assetId === "string" ? snap.assets[it.assetId] : undefined;
  if (!asset) return { kind: "unknown", why: "素材元数据读不到" };
  return type === "motion-graphic" ? motionGraphic(it, asset) : raster(asset);
}
